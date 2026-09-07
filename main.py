import os
import json
import uuid
import re
from datetime import datetime
from typing import List, Optional, Literal, Union, Dict, Any
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from openai import OpenAI
import aiofiles
from fastapi.staticfiles import StaticFiles
import os

# Create your FastAPI app instance
# app = FastAPI() (This should already be in your code)


# =========================================================
# APP CONFIGURATION & STORAGE DIRECTORIES
# =========================================================
app = FastAPI(title="Locus AI Math & Engineering Presentation Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Use /data for cloud persistent disk, fallback to local directory
STORAGE_BASE = os.getenv("STORAGE_PATH", "")
UPLOAD_DIR = os.path.join(STORAGE_BASE, "media_uploads") if STORAGE_BASE else "media_uploads"
DECKS_DIR = os.path.join(STORAGE_BASE, "saved_decks") if STORAGE_BASE else "saved_decks"
STATIC_DIR = "static"

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(DECKS_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

app.mount("/media", StaticFiles(directory=UPLOAD_DIR), name="media")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

client = OpenAI(
    api_key=os.getenv("OPENAI_API_KEY"),
    base_url="https://generativelanguage.googleapis.com/v1beta/openai/"
)

# =========================================================
# PYDANTIC DATA SCHEMAS (JSON DECK SPECIFICATION)
# =========================================================
class Fragment(BaseModel):
    type: str = Field("text", description="text, math, bullet, callout, or code")
    content: str = Field(..., description="Text or raw LaTeX string without enclosing dollar signs for math type")
    highlight: bool = False
    reveal_step: int = Field(1, description="Step sequence index for click-to-reveal")
    label: Optional[str] = None
    clear_screen: bool = Field(False, description="If true, wipes previous text fragments on this slide before revealing.")
    video_sync_time: Optional[float] = Field(None, description="If set, automatically seeks the embedded video to this exact second upon reveal.")

class MediaPanel(BaseModel):
    media_type: str = Field("none", description="none, video, pdf, drive_doc, graph_2d, image, or web_widget")
    src: Optional[str] = Field(None, description="Local URL, uploaded file path, or Google Drive embed URL")
    caption: Optional[str] = None
    graph_formula: Optional[str] = Field(None, description="Formula for 2D interactive graphing")
    autoplay: bool = False
    controls: bool = True

class Slide(BaseModel):
    id: str = Field(default_factory=lambda: f"slide_{uuid.uuid4().hex[:6]}")
    title: str
    subtitle: Optional[str] = ""
    layout: str = Field("split_left_theory", description="split_left_theory, split_right_theory, full_theory, full_media, or grid_2x2")
    partition: float = Field(0.5, description="Ratio of screen width allocated to the primary theory panel")
    theory_fragments: List[Fragment] = []
    media_panel: MediaPanel = Field(default_factory=MediaPanel)
    speaker_notes: Optional[str] = ""

class MediaScript(BaseModel):
    filename: str = Field(..., description="The exact filename used in the media_panel src, e.g., parabola_anim.html or vector_field.py")
    script_type: str = Field(..., description="Indicate whether this is 'html_canvas' or 'manim_python'")
    code: str = Field(..., description="The complete, functional, raw code for the HTML widget or Manim python script.")

class PresentationDeck(BaseModel):
    project_title: str
    subject: str
    author: Optional[str] = "Locus AI Studio"
    theme: str = Field("locus_cinematic", description="neon_dark, slate_emerald, indigo_cyber, nord_frost, or locus_cinematic")
    slides: List[Slide]
    media_scripts: List[MediaScript] = Field(default_factory=list) # Bundles code into the single JSON!

class GeneratedLecture(BaseModel):
    deck: PresentationDeck
    media_scripts: List[MediaScript] = Field(..., description="The code scripts required to generate the visual widgets requested in the slides.")

# --- Requests / Responses ---
class OutlineItem(BaseModel):
    slide_number: int
    title: str
    pedagogy_focus: str
    suggested_layout: str
    suggested_media: str

class GenerateWidgetRequest(BaseModel):
    slide: Slide
    theme: str = "locus_cinematic"

class OutlineResponse(BaseModel):
    topic: str
    deck_summary: str
    outline: List[OutlineItem]

class DraftOutlineRequest(BaseModel):
    topic: str
    target_audience: str = "Standard Engineering Students"
    slide_count: int = 5
    extra_instructions: str = ""

class GenerateDeckRequest(BaseModel):
    topic: str
    approved_outline: List[OutlineItem]
    extra_instructions: str = ""
    theme: str = "locus_cinematic"
    reference_text: Optional[str] = ""
    reference_image: Optional[str] = ""

class AIEditSlideRequest(BaseModel):
    current_slide: Slide
    instruction: str

class SaveDeckRequest(BaseModel):
    filename: str
    deck_data: PresentationDeck

# =========================================================
# PROMPT DEFINITIONS FOR AI STAGES
# =========================================================
OUTLINE_SYSTEM_PROMPT = """You are an elite mathematics and computational engineering presentation architect.
Your objective is to design the lecture structure for college-level mathematics, numerical methods, and engineering sciences.

RULES FOR OUTLINE GENERATION:
1. Break down the topic systematically from intuitive motivation to rigorous algebraic derivations and visual verification.
2. Recommend dedicated slots for media (diagrams, function graphs, Manim videos, or PDF references).
3. Ensure every slide has a clear, focused pedagogical purpose."""

DECK_SYSTEM_PROMPT = r"""You are an elite computational mathematics professor, 3D visualizer, and interactive slide designer.
You produce raw, valid structured JSON slides for a dynamic web lecture engine.

ABSOLUTE MATHEMATICAL, PEDAGOGICAL & FRAGMENT RULES:
1. LATEX SYNTAX:
   - For `type: "math"`, provide clean raw LaTeX (e.g., "\frac{dy}{dx} + P(x)y = Q(x)"). Do NOT enclose in $ signs.
   - For `type: "text"` or `type: "bullet"`, you may include inline math wrapped in single `$`.
2. MINIMAL TEXT & PEDAGOGY:
   - Text descriptions MUST NOT be lengthy. Keep text minimal and punchy.
   - The main focus must be on rigorous explanation, deep mathematical derivations, and visual intuition.
   - Sequence fragments logically with `reveal_step: 1, 2, 3, ...`.
   - Use `clear_screen: true` to wipe previous equations when screen real estate is full.
3. INTERACTIVE MEDIA & GRAPHING (UBIQUITOUS WIDGETS):
   - Almost EVERY slide should feature a web widget (2D or 3D based on the topic) to visually explain the math and real-world application.
   - For ALL interactive visualizations, set `media_panel.media_type` to "web_widget".
   - You MUST invent a clean filename for `src` (e.g., "eigen_3d.html") and provide the FULL HTML/JS code inside the `media_scripts` array at the root of the JSON. DO NOT put raw HTML inside the `src` field.
   
   - VISUAL CLARITY & NO OVERLAPPING (CRITICAL): You must calculate strict padding, coordinate spacing, and margins. Use deterministic geometric layouts (e.g., rigid grids, evenly distributed circular polar coordinates, or strict hierarchical tree spacing). Ensure nodes, data points, labels, and geometry NEVER overlap.
   - 3D RENDERING QUALITY: If simulating 3D in 2D canvas, you MUST implement a depth-sorting array (Painter's Algorithm) to sort all faces/nodes by Z-depth BEFORE drawing them so foreground objects properly occlude background objects. You MUST apply perspective division (`f = focal_length / (focal_length - z)`) to scale X/Y coordinates AND node radii/line widths.
   - MATHEMATICAL ACCURACY: Diagrams must have perfectly correct calculations, exact spatial coordinates, and robust logic.
   
   - ANIMATION MANDATE: Widgets MUST NOT be static pictures. Use JavaScript `requestAnimationFrame` to smoothly animate geometry and derivations.
   - HARDCODED DIMENSIONS: You MUST explicitly set `<canvas width="800" height="600">` and hardcode origin points. DO NOT use `window.innerWidth` for dynamic sizing.
   - CLEAN INTERACTION (INDEPENDENT STATE): The widget MUST manage its own internal progression state (e.g., `let currentStep = 1;`). It MUST NOT communicate with the parent window. TO ALLOW FORWARD/BACKWARD CLICKS WITHOUT BREAKING 3D ORBIT CONTROLS, implement this exact "Smart Tap" logic to advance or reverse its OWN internal state dynamically based on the widget's width: `let startX, startY, startTime; window.addEventListener('pointerdown', e => { startX = e.clientX; startY = e.clientY; startTime = Date.now(); }); window.addEventListener('pointerup', e => { if (Math.abs(e.clientX - startX) < 10 && Math.abs(e.clientY - startY) < 10 && Date.now() - startTime < 300) { if (e.clientX < window.innerWidth / 3) { currentStep = Math.max(1, currentStep - 1); } else { currentStep++; } advanceToStep(currentStep); } });` DO NOT attach standard click listeners that conflict with this.
   - CODE FORMATTING: The HTML/JS code in `media_scripts` MUST be beautifully formatted with proper line breaks (`\n`) and indentation. DO NOT output minified or single-line HTML.
   - STYLING DIRECTIVE: Assume a cinematic studio aesthetic. Hardcode slate/dark navy backgrounds (#0f172a), with neon cyan (#00E5FF), emerald (#10b981), and amber (#fbbf24).
4. COMPACTNESS:
   - Keep slides focused. Avoid text density greater than 4-5 fragments per panel."""

# =========================================================
# WIDGET SYSTEM PROMPT
# =========================================================
WIDGET_SYSTEM_PROMPT = r"""You are an elite computational mathematics professor and 3D visualizer.
Your task is to generate a SINGLE interactive HTML/JS canvas widget for a specific presentation slide.

CRITICAL HTML & RESPONSIVE CANVAS STRUCTURE (NO SCROLLBARS):
You MUST wrap your widget in this exact HTML/CSS skeleton. DO NOT create HTML <div> overlays. Everything must be drawn directly onto the canvas:
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { margin: 0; background: #0f172a; overflow: hidden; font-family: monospace; user-select: none; }
  canvas { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="stage" width="800" height="600"></canvas>
<script>
// Widget logic here
</script>
</body>
</html>

RULES FOR THE WIDGET CODE:
1. MATHEMATICAL ACCURACY & BOUNDING BOX:
   - The visualization must directly verify the slide's text/math fragments.
   - Keep all 3D/2D geometry strictly centered and scaled within the 800x600 canvas coordinate system. Nodes and meshes must not clip off the screen edges.
2. 3D PROJECTION & DEPTH SORTING:
   - If simulating 3D, use a depth-sorting array (Painter's Algorithm) so foreground objects properly occlude background objects.
   - Apply perspective division (`scale = focalLength / (focalLength + z)`). Cap minimum depth to prevent infinite scaling.
3. ANIMATION & FRAME CLEARING:
   - Use `requestAnimationFrame`.
   - On every frame, you MUST clear the canvas buffer:
     `ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, 800, 600);`
4. STEP STATE-MACHINE (1 to 4):
   - Maintain `let currentStep = 1; const maxSteps = 4;`.
   - Implement `function advanceToStep(step) { currentStep = Math.max(1, Math.min(maxSteps, step)); }`.
   - Each step (1, 2, 3, 4) must visibly reveal a new geometric or mathematical layer corresponding to the slide fragments.
5. SMART TAP & INDEPENDENT NAVIGATION:
   - Listen for taps without interfering with drag/orbit controls:
     `let startX, startY, startTime; window.addEventListener('pointerdown', e => { startX = e.clientX; startY = e.clientY; startTime = Date.now(); }); window.addEventListener('pointerup', e => { if (Math.abs(e.clientX - startX) < 15 && Math.abs(e.clientY - startY) < 15 && Date.now() - startTime < 350) { if (e.clientX < window.innerWidth / 3) { currentStep = Math.max(1, currentStep - 1); } else { currentStep = Math.min(maxSteps, currentStep + 1); } advanceToStep(currentStep); } });`
   - DO NOT call undefined functions like `addEventListeners()`.
6. MANDATORY 3-LINE HUD HEADER & FOOTER (CANVAS DIRECT DRAW):
   - Draw directly on the canvas via `ctx.fillText()`:
   - LINE 1 (Title Header): Font: 16px monospace, Color: #00E5FF, Position: (x=20, y=30) -> Exact diagram title.
   - LINE 2 (Step Tracker): Font: 14px monospace, Color: #fbbf24, Position: (x=20, y=55) -> `Step ${currentStep}/${maxSteps}: ${stepDescription}`.
   - LINE 3 (Live Telemetry): Font: 14px monospace, Color: #10b981, Position: (x=20, y=80) -> Dynamic real-time values (e.g., angle, count, partition metrics).
   - FOOTER: Font: 12px monospace, Color: #64748b, Position: (x=20, y=580) -> "Click Left: Prev Step | Click Right: Next Step | [Interaction: Drag/Orbit/Translate]"
7. COLOR PALETTE:
   - Background: #0f172a
   - Primary Features: #00E5FF (Neon Cyan)
   - Secondary Sets/Links: #10b981 (Emerald)
   - Highlights/Markers: #fbbf24 (Amber)
   - Disjoint/Errors: #f43f5e (Crimson)
   - Coordinate Grids/Axes: #334155 / #64748b
8. STRICT JSON ESCAPING:
   - Double-escape all backslashes used in LaTeX or JS regex (e.g., write `\\Omega` instead of `\Omega`) and escape all double quotes (`\"`) and newlines (`\n`) inside the `"code"` string value.

Output ONLY the MediaScript JSON object (containing `filename`, `script_type`: "html_canvas", and `code`). Do not include markdown code block ticks around the JSON or conversational text."""

# =========================================================
# HELPER FUNCTIONS
# =========================================================
def sanitize_google_drive_url(url: str) -> str:
    drive_file_match = re.search(r"/file/d/([a-zA-Z0-9_-]+)", url)
    if drive_file_match:
        file_id = drive_file_match.group(1)
        return f"https://drive.google.com/file/d/{file_id}/preview"
    
    docs_match = re.search(r"/document/d/([a-zA-Z0-9_-]+)", url)
    if docs_match:
        doc_id = docs_match.group(1)
        return f"https://docs.google.com/document/d/{doc_id}/preview"

    return url
# =========================================================
# API ENDPOINTS
# =========================================================
@app.get("/")
async def serve_editor():
    return FileResponse(os.path.join(STATIC_DIR, "editor.html"))

@app.get("/present")
async def serve_presenter():
    return FileResponse(os.path.join(STATIC_DIR, "presenter.html"))
@app.get("/media_editor")
async def serve_media_editor():
    return FileResponse(os.path.join(STATIC_DIR, "media_editor.html"))
@app.get("/sw.js")
async def serve_sw():
    return FileResponse(os.path.join(STATIC_DIR, "sw.js"))

@app.get("/manifest.json")
async def serve_manifest():
    return FileResponse(os.path.join(STATIC_DIR, "manifest.json"))
@app.post("/api/ai/draft_outline", response_model=OutlineResponse)
async def draft_outline(data: DraftOutlineRequest):
    user_prompt = f"""Draft a {data.slide_count}-slide lecture outline on the topic: '{data.topic}'.
Target Audience: {data.target_audience}
Special Guidelines: {data.extra_instructions or 'None'}"""

    try:
        completion = client.beta.chat.completions.parse(
            model="gemini-2.5-flash",
            messages=[
                {"role": "system", "content": OUTLINE_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt}
            ],
            response_format=OutlineResponse,
            max_tokens=4096,
        )
        return completion.choices[0].message.parsed
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate outline: {str(e)}")

import media_generator
app.include_router(media_generator.router)

@app.post("/api/ai/generate_deck", response_model=GeneratedLecture)
async def generate_deck(data: GenerateDeckRequest):
    outline_json = json.dumps([item.model_dump() for item in data.approved_outline], indent=2)
    
    # Base text prompt
    user_content = f"""Generate a full interactive Presentation Deck AND write the raw code for all required media files for topic '{data.topic}'.
Theme: {data.theme}
User Custom Instructions: {data.extra_instructions or 'Standard'}
"""
    
    # Append attached text file contents if provided
    if data.reference_text:
        user_content += f"\n\n--- USER ATTACHED REFERENCE DOCUMENT ---\n{data.reference_text}\n--------------------------------------\n"

    user_content += f"\nAPPROVED OUTLINE TO CONVERT INTO DETAILED SLIDES:\n{outline_json}"

    # Construct messages array (handles standard text or multimodal image upload)
    messages = [{"role": "system", "content": DECK_SYSTEM_PROMPT}]
    
    if data.reference_image:
        messages.append({
            "role": "user",
            "content": [
                {"type": "text", "text": user_content},
                {"type": "image_url", "image_url": {"url": data.reference_image}}
            ]
        })
    else:
        messages.append({"role": "user", "content": user_content})

    try:
        completion = client.beta.chat.completions.parse(
            model="gemini-2.5-flash",
            messages=messages,
            response_format=GeneratedLecture,
            max_tokens=16384,
        )
        return completion.choices[0].message.parsed
    except Exception as e:
        print(f"\n--- AI GENERATION CRASH LOG ---")
        print(f"Error Details: {str(e)}")
        print(f"-------------------------------\n")
        raise HTTPException(status_code=500, detail=f"Failed to generate complete deck: {str(e)}")

@app.post("/api/ai/generate_widget", response_model=MediaScript)
async def generate_widget(data: GenerateWidgetRequest):
    slide_json = json.dumps(data.slide.model_dump(), indent=2)
    user_prompt = f"""Generate the complete, standalone HTML/JS canvas code for the web widget described by this slide.
Theme: {data.theme}

CURRENT SLIDE DATA:
{slide_json}"""

    try:
        # We switch to standard .create() instead of .parse() to prevent the strict wrapper from crashing on massive code blocks
        completion = client.chat.completions.create(
            model="gemini-2.5-flash",
            messages=[
                {"role": "system", "content": WIDGET_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt}
            ],
            response_format={"type": "json_object"},
            max_tokens=16384,
        )
        
        raw_content = completion.choices[0].message.content.strip()
        
        # Clean up markdown formatting if the AI accidentally wraps the JSON in backticks
        if raw_content.startswith("```"):
            raw_content = re.sub(r"^```[a-zA-Z]*\n", "", raw_content)
            raw_content = re.sub(r"\n```$", "", raw_content)
            raw_content = raw_content.strip()
            
        # strict=False allows the parser to ignore unescaped newlines/tabs inside the code string
        parsed_json = json.loads(raw_content, strict=False)
        return MediaScript(**parsed_json)
        
    except Exception as e:
        print(f"\n--- WIDGET GENERATION ERROR ---")
        print(f"Error Details: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to generate widget: {str(e)}")

@app.post("/api/ai/refine_slide", response_model=Slide)
async def refine_slide(data: AIEditSlideRequest):
    slide_json = json.dumps(data.current_slide.model_dump(), indent=2)
    user_prompt = f"""Modify the following slide according to the instruction:
INSTRUCTION: {data.instruction}

CURRENT SLIDE JSON:
{slide_json}"""

    try:
        completion = client.beta.chat.completions.parse(
            model="gemini-2.5-flash",
            messages=[
                {"role": "system", "content": DECK_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt}
            ],
            response_format=Slide,
            max_tokens=4096,
        )
        return completion.choices[0].message.parsed
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to refine slide: {str(e)}")

class MediaEditRequest(BaseModel):
    code: str
    instruction: str
    script_type: str

@app.post("/api/ai/edit_media_code")
async def edit_media_code(data: MediaEditRequest):
    user_prompt = f"""You are an expert programmer. Modify the following {data.script_type} code based on this instruction:
INSTRUCTION: {data.instruction}

```
{data.code}
```

CRITICAL RULE: Return ONLY the raw modified code. Do NOT wrap the code in markdown fences (like ```python). Do NOT provide explanations."""

    try:
        completion = client.beta.chat.completions.parse(
            model="gemini-2.5-flash",
            messages=[{"role": "user", "content": user_prompt}],
            max_tokens=8192,
        )
        
        raw_code = completion.choices[0].message.content.strip()
        
        if raw_code.startswith("```"):
            raw_code = re.sub(r"^```[a-zA-Z]*\n", "", raw_code)
            raw_code = re.sub(r"\n```$", "", raw_code)
            raw_code = raw_code.strip()
            
        return {"status": "success", "modified_code": raw_code}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to edit code: {str(e)}")

# =========================================================
# FILE & MEDIA UPLOAD / STORAGE ENDPOINTS
# =========================================================
@app.post("/api/upload_media")
async def upload_media(file: UploadFile = File(...)):
    try:
        safe_filename = file.filename or "upload.file"
        ext = os.path.splitext(safe_filename)[1]
        unique_name = f"{uuid.uuid4().hex[:8]}_{safe_filename}"
        file_path = os.path.join(UPLOAD_DIR, unique_name)

        async with aiofiles.open(file_path, "wb") as out_file:
            while content := await file.read(1024 * 1024):
                await out_file.write(content)

        media_type = "video" if ext.lower() in [".mp4", ".webm", ".mov"] else (
            "pdf" if ext.lower() == ".pdf" else "image"
        )

        return {
            "status": "success",
            "media_url": f"/media/{unique_name}",
            "filename": file.filename,
            "media_type": media_type
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Media upload failed: {str(e)}")

@app.post("/api/convert_drive_link")
async def convert_drive_link(link: str = Form(...)):
    converted = sanitize_google_drive_url(link.strip())
    return {"status": "success", "embed_url": converted}

@app.post("/api/save_deck")
async def save_deck(payload: SaveDeckRequest):
    try:
        safe_name = "".join([c if c.isalnum() or c in "-_" else "_" for c in payload.filename]).strip("_")
        if not safe_name.endswith(".json"):
            safe_name += ".json"
        
        filepath = os.path.join(DECKS_DIR, safe_name)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(payload.deck_data.model_dump(), f, indent=2)

        return {"status": "success", "filename": safe_name, "message": f"Saved deck to {safe_name}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Save failed: {str(e)}")

@app.get("/api/load_deck")
async def load_deck(filename: str):
    safe_name = "".join([c if c.isalnum() or c in "-_" else "_" for c in filename]).strip("_")
    if not safe_name.endswith(".json"):
        safe_name += ".json"
    filepath = os.path.join(DECKS_DIR, safe_name)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail=f"File {filename} not found.")
    
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {"status": "success", "deck": data}

@app.get("/api/list_decks")
async def list_decks():
    files = [f for f in os.listdir(DECKS_DIR) if f.endswith(".json")]
    return {"status": "success", "decks": sorted(files)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)