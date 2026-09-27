"""FLOODLIGHT dev entrypoint: python run.py → http://localhost:8737 (LAN-visible for the /phone receiver)"""
import uvicorn

if __name__ == "__main__":
    uvicorn.run("floodlight.app:app", host="0.0.0.0", port=8737, reload=False)
