"""Curated commercial and geographic knowledge for the v2 synthetic dataset.

The catalog encodes market context, never creator reliability or worth.
"""

REGIONS = {
    "NG": ("West", ["GH", "GB", "US", "CA"], ["en", "yo", "ig", "ha"]),
    "GH": ("West", ["NG", "GB", "US", "CA"], ["en", "ak", "ee"]),
    "SN": ("West", ["CI", "FR", "BE", "CA"], ["fr", "wo"]),
    "CI": ("West", ["SN", "FR", "BE", "CA"], ["fr"]),
    "KE": ("East", ["TZ", "UG", "GB", "US"], ["sw", "en"]),
    "TZ": ("East", ["KE", "UG", "GB", "AE"], ["sw", "en"]),
    "UG": ("East", ["KE", "TZ", "GB", "US"], ["en", "lg", "sw"]),
    "RW": ("East", ["UG", "KE", "FR", "BE"], ["rw", "en", "fr"]),
    "ET": ("East", ["KE", "US", "AE", "GB"], ["am", "en"]),
    "ZA": ("Southern", ["BW", "ZW", "GB", "US"], ["en", "zu", "xh", "af"]),
    "ZW": ("Southern", ["ZA", "BW", "GB", "US"], ["en", "sn", "nd"]),
    "BW": ("Southern", ["ZA", "ZW", "GB", "US"], ["en", "tn"]),
    "ZM": ("Southern", ["ZA", "ZW", "GB", "US"], ["en", "bem", "ny"]),
    "MZ": ("Southern", ["ZA", "PT", "BR", "AO"], ["pt", "ts"]),
    "EG": ("North", ["AE", "SA", "GB", "US"], ["ar", "en"]),
    "MA": ("North", ["FR", "ES", "BE", "CA"], ["ar", "fr", "zgh"]),
    "CM": ("Central", ["NG", "FR", "GB", "CA"], ["fr", "en"]),
    "CD": ("Central", ["FR", "BE", "CA", "CG"], ["fr", "ln"]),
}

CITIES = {
    "NG": ["Lagos", "Abuja", "Port Harcourt", "Enugu", "Ibadan"], "GH": ["Accra", "Kumasi", "Takoradi"],
    "SN": ["Dakar", "Saint-Louis"], "CI": ["Abidjan", "Bouaké"], "KE": ["Nairobi", "Mombasa", "Kisumu"],
    "TZ": ["Dar es Salaam", "Arusha", "Zanzibar City"], "UG": ["Kampala", "Jinja"], "RW": ["Kigali", "Huye"],
    "ET": ["Addis Ababa", "Bahir Dar"], "ZA": ["Johannesburg", "Cape Town", "Durban", "Pretoria"],
    "ZW": ["Harare", "Bulawayo"], "BW": ["Gaborone", "Francistown"], "ZM": ["Lusaka", "Ndola"],
    "MZ": ["Maputo", "Beira"], "EG": ["Cairo", "Alexandria"], "MA": ["Casablanca", "Rabat", "Marrakesh"],
    "CM": ["Douala", "Yaoundé"], "CD": ["Kinshasa", "Lubumbashi"],
}

NICHE_CATALOG = {
    "Fashion & Lifestyle": ["modest fashion", "streetwear styling", "sustainable wardrobes", "luxury accessories", "workwear", "textile care", "thrift styling", "menswear"],
    "Tech & Gadgets": ["mobile photography", "consumer electronics", "creator tools", "smart home", "software tutorials", "device accessibility", "AI productivity", "app reviews"],
    "Food & Culinary": ["home cooking", "restaurant discovery", "baking", "plant-forward meals", "food travel", "quick recipes", "culinary storytelling", "beverage culture"],
    "Fitness": ["running", "strength training", "mobility", "football fitness", "outdoor wellness", "dance fitness", "home workouts", "recovery"],
    "Comedy & Skits": ["workplace comedy", "family sketches", "observational humour", "character comedy", "social satire", "improvisation", "campus comedy", "visual comedy"],
    "Music": ["music production", "live performance", "instrument education", "album commentary", "DJ culture", "songwriting", "dance music", "artist interviews"],
    "Travel": ["city guides", "responsible tourism", "business travel", "budget travel", "luxury stays", "outdoor adventure", "food travel", "diaspora travel"],
    "Beauty": ["natural hair", "protective styles", "skincare education", "makeup artistry", "men's grooming", "fragrance", "beauty on a budget", "editorial beauty"],
    "Finance & Fintech": ["personal finance", "creator business", "small-business tools", "digital payments", "investing education", "freelance finance", "consumer rights", "career growth"],
    "Parenting": ["early learning", "family travel", "family nutrition", "teen parenting", "play-based learning", "working parents", "family budgeting", "inclusive education"],
    "Gaming": ["mobile gaming", "esports", "indie games", "game accessibility", "streaming setups", "sports games", "game reviews", "community tournaments"],
    "Art & Design": ["illustration", "graphic design", "photography", "architecture", "product design", "animation", "interior design", "creative entrepreneurship"],
}

FORMATS = {
    "instagram": ["reel", "carousel", "story_set", "photo_post"],
    "tiktok": ["short_video", "live_demo", "story_video"],
    "youtube": ["long_video", "short_video", "integration", "livestream"],
    "x": ["thread", "short_post", "live_audio"],
    "facebook": ["short_video", "photo_post", "livestream"],
}
FORMAT_EFFORT = {"short_post": .45, "photo_post": .7, "story_set": .65, "thread": .75, "carousel": .9,
                 "short_video": 1.0, "reel": 1.05, "story_video": .9, "live_audio": .9,
                 "integration": 1.15, "live_demo": 1.2, "livestream": 1.3, "long_video": 1.8}

CAMPAIGN_ARCHETYPES = [
    {"industry":"Consumer Technology","products":["wireless earbuds","mobile photo editor","creator laptop","smartphone camera"],"category":"Tech & Gadgets","niches":["mobile photography","consumer electronics","creator tools","app reviews"],"objectives":["product_education","qualified_traffic","launch_awareness"],"formats":["short_video","reel","long_video","integration"],"tones":["clear and practical","curious and hands-on","polished but approachable"],"metrics":["qualified clicks","video completion rate","product-page visits"]},
    {"industry":"Financial Technology","products":["cross-border wallet","freelancer account","merchant payment app","budgeting tool"],"category":"Finance & Fintech","niches":["digital payments","freelance finance","small-business tools","personal finance"],"objectives":["product_education","app_signups","qualified_traffic"],"formats":["short_video","reel","thread","carousel"],"tones":["trustworthy and plain-spoken","educational and transparent","confident without hype"],"metrics":["verified sign-ups","qualified clicks","saves and shares"]},
    {"industry":"Beauty and Personal Care","products":["melanin-friendly sunscreen","curl care range","fragrance collection","gentle cleanser"],"category":"Beauty","niches":["natural hair","skincare education","fragrance","men's grooming"],"objectives":["launch_awareness","product_education","ugc_production"],"formats":["reel","short_video","carousel","long_video"],"tones":["warm and evidence-aware","sensory and elegant","honest and routine-led"],"metrics":["saves","completion rate","sample requests"]},
    {"industry":"Apparel and Accessories","products":["travel capsule collection","performance trainers","workwear edit","artisan accessory line"],"category":"Fashion & Lifestyle","niches":["streetwear styling","sustainable wardrobes","workwear","luxury accessories"],"objectives":["launch_awareness","ugc_production","conversions"],"formats":["reel","short_video","carousel","photo_post"],"tones":["editorial and expressive","confident and energetic","considered and contemporary"],"metrics":["product views","saves","attributed sales"]},
    {"industry":"Food and Beverage","products":["sparkling fruit drink","meal-kit service","specialty coffee","kitchen appliance"],"category":"Food & Culinary","niches":["quick recipes","beverage culture","home cooking","culinary storytelling"],"objectives":["product_education","trial","ugc_production"],"formats":["short_video","reel","live_demo","carousel"],"tones":["inviting and useful","vibrant and social","sensory and instructional"],"metrics":["recipe saves","trial redemptions","video completion rate"]},
    {"industry":"Travel and Hospitality","products":["regional flight pass","boutique hotel network","travel booking app","city experience pass"],"category":"Travel","niches":["city guides","responsible tourism","business travel","diaspora travel"],"objectives":["destination_awareness","qualified_traffic","bookings"],"formats":["reel","short_video","long_video","carousel"],"tones":["immersive and practical","aspirational but attainable","curious and respectful"],"metrics":["itinerary saves","booking-page visits","completed bookings"]},
    {"industry":"Education Technology","products":["career learning platform","language-learning app","coding bootcamp","children's learning kit"],"category":"Parenting","secondary_category":"Tech & Gadgets","niches":["early learning","career growth","software tutorials","inclusive education"],"objectives":["product_education","course_signups","qualified_traffic"],"formats":["short_video","carousel","long_video","thread"],"tones":["encouraging and specific","demonstrative and credible","accessible and optimistic"],"metrics":["course enquiries","trial starts","lesson-page visits"]},
    {"industry":"Sport and Wellness","products":["running shoe","recovery app","home training kit","community race series"],"category":"Fitness","niches":["running","recovery","home workouts","outdoor wellness"],"objectives":["community_participation","product_education","conversions"],"formats":["reel","short_video","long_video","livestream"],"tones":["energetic and inclusive","coach-like and practical","motivating without body claims"],"metrics":["challenge registrations","workout saves","product views"]},
    {"industry":"Entertainment and Gaming","products":["mobile game","streaming subscription","gaming headset","community tournament"],"category":"Gaming","secondary_category":"Comedy & Skits","niches":["mobile gaming","esports","streaming setups","visual comedy"],"objectives":["launch_awareness","installs","community_participation"],"formats":["short_video","livestream","integration","reel"],"tones":["playful and energetic","community-led","witty and fast-paced"],"metrics":["installs","stream participation","watch time"]},
    {"industry":"Creative Software","products":["illustration suite","video editing tool","portfolio builder","animation app"],"category":"Art & Design","secondary_category":"Tech & Gadgets","niches":["illustration","animation","creator tools","graphic design"],"objectives":["product_education","trial","ugc_production"],"formats":["long_video","short_video","carousel","livestream"],"tones":["process-led and inspiring","technical but accessible","visually inventive"],"metrics":["trial starts","tutorial completions","project shares"]},
]

BRAND_WORDS = ["Aster", "Kora", "Mosaic", "Northstar", "Safi", "Tideway", "Baobab", "Lumen", "Nia", "Cedar", "Orbit", "Juniper", "Vela", "Canopy", "Solace"]
AFRICAN_HQ = [("Lagos","NG"),("Accra","GH"),("Nairobi","KE"),("Johannesburg","ZA"),("Dakar","SN"),("Kigali","RW"),("Cairo","EG"),("Casablanca","MA"),("Abidjan","CI"),("Kampala","UG")]
GLOBAL_HQ = [("London","GB"),("New York","US"),("Paris","FR"),("Berlin","DE"),("Dubai","AE"),("Toronto","CA"),("São Paulo","BR"),("Singapore","SG")]
