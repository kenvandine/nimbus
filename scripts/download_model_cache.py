#!/usr/bin/env python3
"""Download Hugging Face models into a local cache directory structure.

This preserves the models--, blobs/, refs/, and snapshots/ directory structure
so it can be sideloaded directly into the lemonade-server snap cache.
"""

import argparse
import os
import sys
from huggingface_hub import hf_hub_download

def download_model(repo_id, filename, cache_dir):
    print(f"Downloading '{filename}' from repository '{repo_id}'...")
    try:
        path = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            cache_dir=cache_dir,
            resume_download=True
        )
        print(f"Successfully downloaded to: {path}")
    except Exception as exc:
        print(f"Error downloading {filename}: {exc}", file=sys.stderr)
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser(description="Download HF models for Nimbus sideloading")
    parser.add_argument("--repo", required=True, help="Hugging Face repository ID (e.g., unsloth/Qwen3.5-9B-GGUF)")
    parser.add_argument("--files", required=True, help="Comma-separated filenames (e.g., Qwen3.5-9B-Q4_K_M.gguf,mmproj-F16.gguf)")
    parser.add_argument("--dest", required=True, help="Target cache directory")
    args = parser.parse_args()

    files = [f.strip() for f in args.files.split(",") if f.strip()]
    os.makedirs(args.dest, exist_ok=True)

    for filename in files:
        download_model(args.repo, filename, args.dest)

if __name__ == "__main__":
    main()
