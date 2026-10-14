# Setup and Configuration

[Project overview](../README.md) · [Platform guide](../docs/platform-guide.md)

The platform uses the Node.js standard library and does not require `npm install`. The setup script checks tools, saves configuration, manages the server, and runs verification. Run all commands from the repository root.

## Prerequisites

| Tool | When you need it |
|---|---|
| Node.js 20+ | Required to run the platform. Node.js 22+ is required for browser checks and screenshots. |
| Model API key | Required for live generation. Offline mode (`AI_PLATFORM_PROVIDER=sim`) does not need a key. |
| JDK | Required to compile and test Java and SAP CAP Java modules. Discovery checks `JAVA_HOME`, `PATH`, and supported Homebrew locations. |
| Python 3 | Required to test Python modules with the standard library `unittest` runner. |
| Google Chrome | Required for browser checks and preview screenshots. Set `CHROME_PATH` for a custom executable. |
| SAP CDS development kit | Optional for manually compiling generated CDS files. The platform's built-in checks validate their structure. |
| Homebrew | Used by the default toolchain installation commands on macOS. |

When a generated module needs a missing JDK or Python runtime, the platform attempts installation and then checks again. Set `AI_PLATFORM_NO_INSTALL=1` to disable this behavior. Failed installation is reported as a module failure.

## First run

```bash
git clone https://github.com/winds198912121/ai-platform.git
cd ai-platform

bash setup/install.sh check
bash setup/install.sh configure --port 8788 --provider live
export AI_PLATFORM_API_KEY="your-api-key"
bash setup/install.sh start
```

Open [http://127.0.0.1:8788](http://127.0.0.1:8788). For an offline demo, use `--provider sim` when configuring the server.

To install missing optional tools, inspect the plan and then run it:

```bash
bash setup/install.sh install --dry-run
bash setup/install.sh install
```

## Setup commands

| Command | Purpose |
|---|---|
| `check` | Inspect runtimes, configuration, API key availability, paths, ports, and running instances. Returns a nonzero exit code for blocking issues. |
| `install [--dry-run]` | Install missing optional tools through Homebrew, or print the installation plan. |
| `configure [flags]` | Create or update `setup/ai-platform.env`. Only supplied settings change; the file has permissions `600`. |
| `start` | Start the server in the background and wait for `/api/state` to respond. |
| `status` | Show process, port, paths, instance count, and API status. |
| `stop` | Stop the server recorded in the current port's PID file. |
| `verify [--live]` | Run the verification suite. `--live` adds model-backed tests and consumes API usage. |
| `selftest` | Test the setup script's configuration and process-management helpers. |
| `help` | Print command usage. |

Configuration flags: `--port`, `--host`, `--provider`, `--model`, `--base-url`, `--api-key`, `--data`, `--workspace`, and `--concurrency`. The `configure --show` option prints the saved file, including any stored API key.

## Configuration

When using the setup script, precedence is:

**Command-line flags > exported environment variables > `setup/ai-platform.env` > defaults.**

Starting `node server.mjs` directly does not load the setup file. To load it explicitly:

```bash
set -a
. setup/ai-platform.env
set +a
node server.mjs
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AI_PLATFORM_HOST` | `127.0.0.1` | Bind address |
| `AI_PLATFORM_PORT` | `8788` | HTTP port |
| `AI_PLATFORM_PROVIDER` | `live` | `live` for model calls; `sim` for offline templates |
| `AI_PLATFORM_API_KEY` | None | API key for the configured model endpoint |
| `AI_PLATFORM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI-compatible API base URL |
| `AI_PLATFORM_MODEL` | `deepseek-v4-flash` | Default model; a project can override it per stage |
| `AI_PLATFORM_DATA` | `data/projects.json` | Project state file |
| `AI_PLATFORM_WORKSPACE` | `workspace/` | Generated files directory |
| `AI_PLATFORM_CONCURRENCY` | `3` | Concurrent development slots, from `1` to `8`; `1` enables serial review |
| `AI_PLATFORM_SPEED` | `1` | Step pacing multiplier; `0` removes pacing delays |
| `AI_PLATFORM_TIMEOUT_MS` | `180000` | Model call timeout in milliseconds |
| `AI_PLATFORM_TEST_TIMEOUT_MS` | `120000` | Test command timeout in milliseconds |
| `AI_PLATFORM_NO_INSTALL` | Unset | Set to `1` to disable automatic toolchain installation |
| `AI_PLATFORM_INSTALL_CMD` | Unset | Custom toolchain installation command, executed through `sh -c` |
| `CHROME_PATH` | Default macOS Chrome path | Browser executable for UI checks and screenshots |

API key lookup in `agent.mjs`: `AI_PLATFORM_API_KEY`, then `DEEPSEEK_API_KEY`, then `OPENAI_API_KEY`, then a DeepSeek or platform key in `~/.hermes/.env`. Changing the endpoint, default model, or key requires restarting the server.

## Start, inspect, and stop

```bash
bash setup/install.sh start
bash setup/install.sh status
bash setup/install.sh stop
```

The setup script creates:

```text
setup/ai-platform.env               Saved configuration
setup/run/ai-platform-<port>.pid     Server process ID
setup/run/ai-platform-<port>.log     Server output
```

Each running instance needs its own port, state file, and workspace. A lock prevents two servers from using the same state file. For a second instance, run:

```bash
AI_PLATFORM_PORT=8899 \
AI_PLATFORM_DATA=/tmp/ai-platform-demo/projects.json \
AI_PLATFORM_WORKSPACE=/tmp/ai-platform-demo/workspace \
AI_PLATFORM_PROVIDER=sim \
bash setup/install.sh start
```

Use the same environment overrides with `status` and `stop` to select that instance.

## Verification

```bash
bash setup/install.sh selftest
bash setup/install.sh verify
```

Verification runs unit tests, offline HTTP end-to-end tests, and browser UI checks. Chrome is needed for UI checks; the script reports a skip if it is unavailable. For live model tests, use `bash setup/install.sh verify --live` with an API key and network access.

## Troubleshooting

| Problem | Action |
|---|---|
| Live generation reports a missing API key | Export `AI_PLATFORM_API_KEY`, or save it with `configure --api-key`. Use `sim` for an offline demo. |
| Java or Python tests cannot run | Check the required runtime with `check`; use `install` or install it manually. Java discovery verifies `javac -version`. |
| Browser checks report `SKIP` | Install Chrome or set `CHROME_PATH` to its executable. |
| Port is already in use | Stop the instance using it or configure another port. |
| Server reports an existing instance | Stop the server holding the state-file lock, or use a different `AI_PLATFORM_DATA` path. |
| A model setting has no effect | Restart after changing environment variables. Project stage-model changes apply to the next call. |
| Server fails to start | Inspect `setup/run/ai-platform-<port>.log` and run `check` again. |
| Project needs a fresh run | Use **Rebuild** in the dashboard. It clears generated deliverables and history while preserving project skills and input materials. |
