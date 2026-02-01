import subprocess, json, time, sys

process = subprocess.Popen(
    [sys.executable, "src/main.py", "--persistent"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    text=True, bufsize=1
)

# Wait for ready
while True:
    line = process.stdout.readline()
    if '{"status"' in line: break

print("Model ready. Sending 3 jobs...")
times = []
for i in range(3):
    job = json.dumps({"prompt": f"test image {i+1}", "size": "S"}) + "\n"
    start = time.time()
    process.stdin.write(job)
    process.stdin.flush()
    resp = process.stdout.readline()
    t = time.time() - start
    times.append(t)
    print(f"Job {i+1}: {t:.2f}s")

process.stdin.close()
process.wait()

print(f"\nResults: Job1={times[0]:.1f}s, Job2={times[1]:.1f}s, Job3={times[2]:.1f}s")
if times[0] > times[1]:
    print(f"Speedup: {(1 - times[1]/times[0])*100:.0f}% faster after warmup")
