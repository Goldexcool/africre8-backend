import OpenAI, { toFile } from 'openai';
import { z } from 'zod';
import type { PostMetadata } from './content.js';

// Azure OpenAI (vision) does the content check; Groq does speech-to-text and a text-only fallback.
const azure = () =>
  process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY
    ? new OpenAI({ baseURL: process.env.AZURE_OPENAI_ENDPOINT, apiKey: process.env.AZURE_OPENAI_API_KEY })
    : null;
const groq = () => (process.env.GROQ_API_KEY ? new OpenAI({ baseURL: process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY }) : null);

const AnalysisSchema = z.object({
  checks: z.array(
    z.object({
      requirement: z.string(),
      passed: z.boolean(),
      confidence: z.number(),
      evidence: z.string(),
    }),
  ),
  summary: z.string(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// Strict JSON schema for response_format (kept in sync with AnalysisSchema).
const JSON_SCHEMA = {
  name: 'verification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['checks', 'summary'],
    properties: {
      checks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['requirement', 'passed', 'confidence', 'evidence'],
          properties: {
            requirement: { type: 'string', description: 'The requirement being checked, copied from the list' },
            passed: { type: 'boolean' },
            confidence: { type: 'number', description: '0 to 1: how sure you are given only the evidence provided' },
            evidence: { type: 'string', description: 'What you saw or heard, citing frame numbers ("frame 3") or quoting the transcript' },
          },
        },
      },
      summary: { type: 'string', description: 'Two sentences for the brand: what the content shows/says and whether it meets the agreement' },
    },
  },
} as const;

const SYSTEM = `You verify creator content for brand campaigns on AfiCre8. You get frames sampled from a social video, a transcript of its audio, and its caption, plus the agreed requirements.
For each requirement decide, from that evidence only, whether it is met. Use the frames for what must be shown (e.g. a red handbag clearly featured) and the transcript for what must be said (e.g. the brand is mentioned by name, a promo code is read out).
Be literal and fair. If the evidence is too thin to judge, say so and give a low confidence instead of guessing. Hashtags, account and dates are checked separately; don't judge them.
Your output helps a human brand reviewer; it never releases payment on its own.`;

/** Speech-to-text for the post's audio (mp3 buffer). null = audio unavailable ('' = no speech). */
export async function transcribe(audio: Buffer): Promise<string | null> {
  const client = groq();
  if (!client || !audio.length) return null;
  try {
    const r = await client.audio.transcriptions.create({
      model: process.env.GROQ_TRANSCRIBE_MODEL ?? 'whisper-large-v3-turbo',
      file: await toFile(audio, 'audio.mp3'),
    });
    return r.text.trim();
  } catch {
    return null;
  }
}

export async function analyzeContent(input: {
  brief: string;
  requirements: string[];
  meta: PostMetadata;
  frames: string[];
  transcript: string | null;
}): Promise<{ analysis: Analysis; model: string } | { error: string }> {
  if (!input.requirements.length) return { error: 'No content requirements to check' };
  const prompt = [
    `Campaign brief: ${input.brief}`,
    `Platform: ${input.meta.platform}`,
    `Caption: ${input.meta.caption.slice(0, 2000) || '(none)'}`,
    input.transcript === null
      ? 'Audio transcript: UNAVAILABLE (the audio could not be extracted). Requirements about what is said cannot be confirmed: mark them passed=false with confidence 0.2 and say the audio was unavailable.'
      : `Audio transcript: ${input.transcript.slice(0, 6000) || '(audio present, no speech detected)'}`,
    'Requirements to check:',
    ...input.requirements.map((r, i) => `${i + 1}. ${r}`),
  ].join('\n');

  const az = azure();
  if (az && input.frames.length) {
    try {
      const model = process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? 'gpt-5.3-chat';
      const r = await az.chat.completions.create({
        model,
        max_completion_tokens: Number(process.env.AZURE_OPENAI_MAX_TOKENS ?? 3000),
        response_format: { type: 'json_schema', json_schema: JSON_SCHEMA },
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: [
              ...input.frames.flatMap((data, i) => [
                { type: 'text' as const, text: `Frame ${i + 1}` },
                { type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${data}`, detail: 'low' as const } },
              ]),
              { type: 'text', text: prompt },
            ],
          },
        ],
      });
      const parsed = AnalysisSchema.safeParse(JSON.parse(r.choices[0]?.message.content ?? 'null'));
      if (parsed.success) return { analysis: parsed.data, model: `azure:${model}` };
    } catch {
      // fall through to the text-only fallback
    }
  }

  // No vision available: judge from caption + transcript only, capped at low confidence → human review.
  const g = groq();
  if (!g) return { error: 'AI verification not configured' };
  try {
    const model = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';
    const r = await g.chat.completions.create({
      model,
      response_format: { type: 'json_schema', json_schema: JSON_SCHEMA },
      messages: [
        { role: 'system', content: `${SYSTEM}\nNo frames are available this time: you only have text, so visual requirements cannot be confirmed.` },
        { role: 'user', content: prompt },
      ],
    });
    const parsed = AnalysisSchema.safeParse(JSON.parse(r.choices[0]?.message.content ?? 'null'));
    if (!parsed.success) return { error: 'AI returned an unreadable result' };
    parsed.data.checks.forEach((c) => (c.confidence = Math.min(c.confidence, 0.5)));
    return { analysis: parsed.data, model: `groq:${model}` };
  } catch (e) {
    return { error: `AI verification failed: ${(e as Error).message}` };
  }
}
