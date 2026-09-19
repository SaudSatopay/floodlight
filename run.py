"""FLOODLIGHT dev entrypoint: python run.py → http://localhost:8737"""
import uvicorn

if __name__ == "__main__":
    uvicorn.run("floodlight.app:app", host="127.0.0.1", port=8737, reload=False)
