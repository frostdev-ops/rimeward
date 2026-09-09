**Section 1 · Desktop only** · [Wiki home](Home) · Next: [Make your workspace](Desktop-Workspace)

Use this path to run Rimeward entirely as a desktop application. You do not need a Rimeward account on a server, a domain, Docker, a reverse proxy, or an externally reachable port. The installed app bundles its backend, Node runtime, Chromium, and editor tools, and creates its local owner on first launch.

## Requirements

| Platform | Installation and requirements |
| --- | --- |
| macOS | Apple Silicon, macOS 14 or newer. Download the DMG and move Rimeward into Applications. Intel Mac installers are not provided. |
| Windows | Use the Windows installer from the release assets. The release workflow targets x86-64 Windows. |
| Linux | Use the DEB or AppImage. Current packages target Ubuntu 24.04 or newer, or an equivalent system with glibc 2.39, WebKitGTK 4.1, and PipeWire 0.3.65 or newer. |

Download from [Rimeward Releases](https://github.com/frostdev-ops/rimeward/releases/latest) and check that release's notes. You do not need to install Node or Rust to run a published installer. Local development tools for your own projects, Git, and optional CLI agents remain separate installations.

For a downloaded AppImage, make it executable in your file manager or with `chmod +x <downloaded-file>.AppImage`, then launch it. On Debian/Ubuntu, install the downloaded DEB with `sudo apt install ./<downloaded-file>.deb`, substituting the actual filename.

## First launch, without remote access

1. Open Rimeward.
2. Find **Start right here** on the welcome screen.
3. Select **Continue without connecting** to start with a dashboard, or **Open or create a project** to start with your work.
4. If you chose a project, approve the folder you want to use. Rimeward creates or reuses its project page.
5. Use **Edit** to arrange wards, and **Account** to choose your appearance and services.

Leave **Bring your dashboard** and server **Connections** alone for this setup. They are for adding a server later, not prerequisites for the app.

The local backend uses a loopback address on your computer. Keep it local; use the authenticated pairing flow if you later need access from another device.

## Connect AI when you want it

Open **Account → Agent**, choose a provider, and complete the connection shown there. Rime supports the ChatGPT backend (Codex), OpenRouter, OpenAI API keys, and OpenAI-compatible endpoints.

A provider connection is required for new Rime responses. The editor, terminal, layout, and other non-AI tools do not require model credits. A terminal running Codex or Claude Code requires that CLI to be installed and authenticated separately; a Rime provider connection does not sign the CLI in.

For local/offline AI, see [Work with Rime](Desktop-Rime#use-a-local-model). Desktop-only describes where Rimeward runs; cloud AI, online websites, weather, and integrations still need their own network connections.

## Optional integrations

Start with notes, a routine timer, a browser, and a project. Add mail, calendar, Notion, or messaging only as needed through Account and the relevant ward's Configure dialog.

A standalone installation can use its own service credentials. OAuth services also need an application registration, runtime client-credential configuration, and correct callbacks: use the desktop's actual stable loopback origin, not the example server URL. The [integration guide](Remote-Integrations) lists callback paths and the packaged desktop's configuration limitations. This advanced setup is optional and does not require hosting Rimeward remotely.

## Optional: build the desktop from source

Use this if you want to develop Rimeward or try source changes that are not in an installer yet.

You need Git, Node **22.18 or newer**, npm, Rust via rustup, and the target platform's Tauri build dependencies. The repository pins its Rust toolchain in `rust-toolchain.toml`; match the platform packages in the [desktop workflow](https://github.com/frostdev-ops/rimeward/blob/main/.github/workflows/desktop.yml). Build on the target operating system.

```sh
git clone https://github.com/frostdev-ops/rimeward.git
cd rimeward
npm ci
npm run desktop:dev
```

To build a local installer instead:

```sh
npm run desktop:build
```

The prebuild stages the backend, native modules, Chromium, and bundled Node before invoking Tauri. This downloads dependencies and is substantially heavier than installing a release. A locally built app is not automatically signed or notarized like a distributed release. See [Contributing](https://github.com/frostdev-ops/rimeward/blob/main/CONTRIBUTING.md) for validation and packaging details.

## Why choose this path?

You get direct project access and a customizable agent workspace with minimal administration. Your main responsibilities are keeping the app up to date, backing up local work, and configuring any providers you choose. The tradeoff is availability: when this computer sleeps or Rimeward quits, its running tools and automations cannot serve other work. A server can be added later without moving your project folders.
