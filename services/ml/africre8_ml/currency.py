"""Versioned synthetic comparison rates. NEVER executable payment quotes."""
from decimal import Decimal, ROUND_HALF_UP

RATE_VERSION = "synthetic-usd-reference-v1"
# Currency units per USD. Deliberately fixed demonstration values, not live FX.
RATES = {k: Decimal(v) for k, v in {
    "USD": "1", "NGN": "1500", "EUR": "0.90", "GBP": "0.75",
    "GHS": "15", "KES": "130", "ZAR": "18", "EGP": "50",
    "XOF": "600", "RWF": "1400", "UGX": "3700", "ETB": "130",
}.items()}
ZERO_DECIMAL = {"XOF", "RWF"}


def normalize(amount: str, currency: str) -> str:
    value = Decimal(amount)
    if not value.is_finite() or value <= 0 or currency not in RATES:
        raise ValueError("Expected a positive amount and supported currency")
    return str((value / RATES[currency]).quantize(Decimal("0.01"), ROUND_HALF_UP))


def money(usd: int, currency: str) -> dict:
    unit = Decimal("1") if currency in ZERO_DECIMAL else Decimal("0.01")
    amount = str((Decimal(usd) * RATES[currency]).quantize(unit, ROUND_HALF_UP))
    return {"amount": amount, "currency": currency, "normalized_usd": normalize(amount, currency),
            "rate_version": RATE_VERSION, "purpose": "synthetic_comparison_only"}
