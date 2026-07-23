"""
One-off asset generator for the Home landing screen.

Generates:
  - hero_lifestyle.jpg : full-bleed lifestyle background for the
    "Trade with Confidence" tile front.
  - ad_mercedes.jpeg, ad_swift.jpeg, ad_tcs.jpeg : consistent
    16:9 mock advertising banners that fill the tile without
    letterboxing.

All images target the same landscape aspect (~16:9) so the tile can
render them with resizeMode="cover" and no dead space.

Run once from /app:
    python backend/scripts/generate_home_assets.py
"""
import asyncio
import base64
import os
from pathlib import Path

from dotenv import load_dotenv

# Load backend .env (EMERGENT_LLM_KEY)
BACKEND_ENV = Path(__file__).resolve().parents[1] / ".env"
load_dotenv(BACKEND_ENV)

from emergentintegrations.llm.chat import LlmChat, UserMessage  # noqa: E402

MODEL_ID = "gemini-3.1-flash-image-preview"

# Output destination — the Expo assets/brands folder.
ASSETS_DIR = Path("/app/frontend/assets/brands")
ASSETS_DIR.mkdir(parents=True, exist_ok=True)

# Design cues shared across every prompt so the whole set looks like
# one campaign that belongs with Fourbuy's minimalist black/white app.
DESIGN_LANGUAGE = (
    "Premium modern automotive advertising design. "
    "Cinematic wide 16:9 landscape composition, full-bleed to the edges. "
    "Editorial magazine feel, luxury dealership tone. "
    "Sophisticated tonal contrast, soft directional light, subtle depth of field. "
    "Design must complement a minimalist black-and-white mobile app UI. "
    "No watermarks, no borders, no rounded corners. "
    "High detail, sharp typography set in a clean modern sans-serif."
)

PROMPTS: list[tuple[str, str]] = [
    (
        "hero_lifestyle.jpg",
        (
            "A cinematic lifestyle photograph for a mobile dealer app landing card "
            "titled 'Trade with Confidence'. "
            "Scene: an experienced South African car dealer standing beside a "
            "luxury premium SUV on a polished showroom floor at golden hour, "
            "confidently shaking hands with another dealer just off-frame; "
            "keys glint in a hand in the mid-ground, "
            "a subtle Fourbuy-style black-and-white palette dominates the scene, "
            "warm rim light, moody premium atmosphere, shallow depth of field. "
            "IMPORTANT: leave the LEFT 55% of the frame as a smooth dark "
            "gradient / soft bokeh negative space (no visible objects, no letters, "
            "no words, no watermarks, no signage) so that later a mobile app can "
            "overlay its own headline on top. "
            "The picture MUST NOT contain any text, letters, numbers, logos, "
            "signs, brand names or captions of any kind. Pure photograph only. "
            + DESIGN_LANGUAGE
        ),
    ),
    (
        "ad_mercedes.jpeg",
        (
            "Full-bleed 16:9 luxury automotive banner advertisement. "
            "Hero product: a modern all-electric Mercedes-Benz EQS luxury sedan, "
            "photographed three-quarter front on a reflective dark studio floor "
            "with a soft blue-to-black gradient background. "
            "Left third: bold white headline reading 'THIS IS FOR YOU.' "
            "and directly beneath a lighter subtitle reading 'The all-electric EQS'. "
            "Small tasteful Mercedes-Benz three-pointed-star logo top-left. "
            "Do NOT crop the vehicle. Composition must fill the whole 16:9 frame edge-to-edge. "
            + DESIGN_LANGUAGE
        ),
    ),
    (
        "ad_swift.jpeg",
        (
            "Full-bleed 16:9 energetic urban car banner advertisement. "
            "Hero product: a bright blue Suzuki Swift compact hatchback parked in front of "
            "a colourful graffiti wall in a modern city alley at dusk. "
            "Bold graffiti-style headline in the middle-right reading 'SWIFT', "
            "small tag above reading 'SUZUKI', and a small tag below reading 'TOP UNDERDOG'. "
            "Small clean 'CAR OF THE WEEK' pill badge in the top-left corner. "
            "Bottom-right tiny italic line reading 'Light on its feet — swift on the street.'. "
            "Do NOT crop the vehicle. Composition must fill the whole 16:9 frame edge-to-edge. "
            + DESIGN_LANGUAGE
        ),
    ),
    (
        "ad_tcs.jpeg",
        (
            "Full-bleed 16:9 motorsport-style banner advertisement for a South African "
            "car marketplace brand called 'TheCarScene' (short form 'TCS'). "
            "Left side: a stylised black-red-yellow checkered racing flag sweeping "
            "diagonally with motion trails. "
            "Centre: giant bold sans-serif logotype 'TCS' with each letter set on a "
            "coloured tile (black, red, yellow). "
            "Beneath the logotype in smaller elegant italic script: 'TheCarScene'. "
            "Right side: a sleek dark sports coupe silhouette with subtle rim light "
            "on a plain white studio background so the whole banner reads as a poster. "
            "Composition must fill the whole 16:9 frame edge-to-edge. No empty side bars. "
            + DESIGN_LANGUAGE
        ),
    ),
]


async def generate_one(filename: str, prompt: str) -> None:
    api_key = os.getenv("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY missing in /app/backend/.env")

    chat = (
        LlmChat(
            api_key=api_key,
            session_id=f"fourbuy-home-asset-{filename}",
            system_message=(
                "You are a senior automotive brand art director. "
                "Produce cinematic, full-bleed 16:9 imagery suitable for a "
                "premium mobile app card. Never leave letterbox bars."
            ),
        )
        .with_model("gemini", MODEL_ID)
        .with_params(modalities=["image", "text"])
    )

    msg = UserMessage(text=prompt)
    _, images = await chat.send_message_multimodal_response(msg)
    if not images:
        raise RuntimeError(f"No image returned for {filename}")

    out_path = ASSETS_DIR / filename
    out_path.write_bytes(base64.b64decode(images[0]["data"]))
    print(f"  saved {out_path}  ({out_path.stat().st_size // 1024} KB)")


async def main() -> None:
    for filename, prompt in PROMPTS:
        print(f"Generating {filename} ...")
        try:
            await generate_one(filename, prompt)
        except Exception as exc:  # noqa: BLE001
            print(f"  FAILED {filename}: {exc}")


if __name__ == "__main__":
    asyncio.run(main())
