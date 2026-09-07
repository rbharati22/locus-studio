import os
import re
import subprocess
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()
UPLOAD_DIR = "media_uploads"

class MediaRenderRequest(BaseModel):
    filename: str
    script_type: str
    code: str

@router.post("/api/media/save_asset")
async def save_asset(payload: MediaRenderRequest):
    try:
        base_name = os.path.basename(payload.filename.replace("\\", "/"))
        
        safe_name = "".join([c if c.isalnum() or c in ".-_" else "_" for c in base_name]).strip()
        if not safe_name:
            raise ValueError("Invalid filename")

        file_path = os.path.join(UPLOAD_DIR, safe_name)
        
        clean_code = payload.code.strip()
        if clean_code.startswith("```"):
            clean_code = re.sub(r"^```[a-zA-Z]*\n", "", clean_code)
            clean_code = re.sub(r"\n```$", "", clean_code)
            clean_code = clean_code.strip()

        with open(file_path, "w", encoding="utf-8") as f:
            f.write(clean_code)
            
        if payload.script_type == "manim_python":
            try:
                subprocess.run(
                    ["manim", "-ql", file_path],
                    cwd=UPLOAD_DIR,
                    capture_output=True,
                    text=True,
                    check=True
                )
            except subprocess.CalledProcessError as err:
                raise HTTPException(status_code=500, detail=f"Compilation Error:\n{err.stderr or err.stdout}")
                
        return {
            "status": "success", 
            "filename": safe_name,
            "url": f"/media/{safe_name}"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save media asset: {str(e)}")