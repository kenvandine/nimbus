import subprocess
import time
import sys
import os
import httpx

def main():
    print("Starting backend smoke test...")
    # Setup environment variables for local testing
    env = os.environ.copy()
    env["NIMBUS_CONTROL_MODE"] = "local"
    env["NIMBUS_PORT"] = "8888"
    env["NIMBUS_TLS"] = "0"
    env["NIMBUS_SERVE_FRONTEND"] = "false"
    env["NIMBUS_REFRESH_STORE_ON_STARTUP"] = "false"
    env["SNAP_COMMON"] = "/tmp/nimbus-smoke-test"
    
    # Ensure SNAP_COMMON directory exists
    os.makedirs("/tmp/nimbus-smoke-test", exist_ok=True)
    
    # We spawn uvicorn pointing to backend/main.py
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8888",
            "--app-dir",
            "backend"
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    
    # Wait up to 10 seconds for startup
    success = False
    start_time = time.time()
    while time.time() - start_time < 10:
        try:
            resp = httpx.get("http://127.0.0.1:8888/docs", timeout=1)
            if resp.status_code == 200:
                print("Smoke test PASSED: successfully hit /docs")
                success = True
                break
        except httpx.RequestError:
            time.sleep(0.5)
            
    # Terminate process and fetch logs if it failed
    proc.terminate()
    try:
        stdout, stderr = proc.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()
        
    if not success:
        print("Smoke test FAILED. Process Output:")
        print("STDOUT:", stdout)
        print("STDERR:", stderr)
        sys.exit(1)
    
    sys.exit(0)

if __name__ == "__main__":
    main()
