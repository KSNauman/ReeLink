#!/usr/bin/env python3
"""
ReelLink Local Audio Transcription Worker
Uses faster-whisper to transcribe audio clips locally.
Outputs structured JSON to stdout.
"""
import sys
import os
import json
import argparse

def parse_args():
    parser = argparse.ArgumentParser(description="ReelLink Whisper Worker")
    parser.add_argument("--audio", required=True, help="Path to input WAV/MP3 audio file")
    parser.add_argument("--model", default="base", help="Model size: tiny, base, small, medium")
    parser.add_argument("--device", default="auto", help="Device: cpu, cuda, auto")
    return parser.parse_args()

def main():
    args = parse_args()

    if not os.path.exists(args.audio):
        print(json.dumps({
            "status": "error",
            "error": f"Audio file not found: {args.audio}",
            "text": ""
        }))
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        # Graceful fallback reporting Whisper is not yet installed in Python env
        print(json.dumps({
            "status": "unavailable",
            "error": "faster-whisper package not installed. Install via: pip install faster-whisper",
            "text": "",
            "segments": []
        }))
        sys.exit(0)

    try:
        # Determine device and compute type
        device = args.device.lower()
        if device == "auto":
            try:
                import torch
                device = "cuda" if torch.cuda.is_available() else "cpu"
            except ImportError:
                device = "cpu"

        compute_type = "float16" if device == "cuda" else "int8"

        model = WhisperModel(args.model, device=device, compute_type=compute_type)
        segments, info = model.transcribe(args.audio, beam_size=5)

        collected_segments = []
        full_text = []

        for segment in segments:
            full_text.append(segment.text.strip())
            collected_segments.append({
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip()
            })

        print(json.dumps({
            "status": "success",
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
            "device": device,
            "text": " ".join(full_text),
            "segments": collected_segments
        }))

    except Exception as e:
        print(json.dumps({
            "status": "error",
            "error": str(e),
            "text": ""
        }))
        sys.exit(1)

if __name__ == "__main__":
    main()
