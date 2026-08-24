"""One-off script: generate the new TradeAPP logo.

Uses Gemini Nano Banana (`gemini-3.1-flash-image-preview`) with the
current `trade-ai-logo.png` as a reference so the output preserves
the same look, feel, layout, and colour palette — only the wordmark
inside the rounded square changes from "AI" to "APP", and the
"POWERED BY FOURBUY" tagline is removed.

Run once:  python /app/backend/scripts/generate_tradeapp_logo.py
Output:    /app/frontend/assets/tradeapp-logo.png
"""

import asyncio
import base64
import os
import sys
from pathlib import Path

# Ensure `emergentintegrations` resolves.
from dotenv import load_dotenv
from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent

load_dotenv("/app/backend/.env")


async def main() -> int:
    api_key = os.getenv("EMERGENT_LLM_KEY")
    if not api_key:
        print("ERROR: EMERGENT_LLM_KEY not set", file=sys.stderr)
        return 1

    ref_path = Path("/app/frontend/assets/trade-ai-logo.png")
    if not ref_path.exists():
        print(f"ERROR: reference logo not found at {ref_path}", file=sys.stderr)
        return 1

    with ref_path.open("rb") as f:
        ref_b64 = base64.b64encode(f.read()).decode("utf-8")

    chat = LlmChat(
        api_key=api_key,
        session_id="tradeapp-logo-rebrand",
        system_message="You are a professional logo designer.",
    )
    chat.with_model("gemini", "gemini-3.1-flash-image-preview").with_params(
        modalities=["image", "text"]
    )

    prompt = (
        "Redesign this logo. Keep EXACTLY the same look, feel, layout, "
        "colour palette, typography, and proportions — pure white glyphs "
        "on a solid black square background, with two thin horizontal "
        "lines above and below the wordmark. "
        "\n\nChange ONLY the following two things:\n"
        "1. Inside the rounded white square on the right, replace the "
        "letters 'AI' with the letters 'APP' (in solid black on the "
        "white rounded-square badge, matching the same sans-serif "
        "typeface). The square should widen slightly to accommodate the "
        "extra letter while staying visually balanced.\n"
        "2. Remove the 'POWERED BY FOURBUY' tagline underneath — leave "
        "clean whitespace where it was. Do not replace it with any other "
        "tagline.\n\n"
        "The final wordmark should read 'TRADE' + 'APP' (rounded-square "
        "badge). Keep the bold uppercase sans-serif typeface identical. "
        "Deliver a square PNG."
    )

    msg = UserMessage(text=prompt, file_contents=[ImageContent(ref_b64)])
    text, images = await chat.send_message_multimodal_response(msg)
    print("model reply text:", (text or "")[:200])
    if not images:
        print("ERROR: model returned no images", file=sys.stderr)
        return 1

    out_path = Path("/app/frontend/assets/tradeapp-logo.png")
    image_bytes = base64.b64decode(images[0]["data"])
    out_path.write_bytes(image_bytes)
    print(f"OK: wrote {out_path} ({len(image_bytes):,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
