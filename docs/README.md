# Rimeward documentation

Start with the [project README](../README.md) for an introduction and the [GitHub wiki](https://github.com/frostdev-ops/rimeward/wiki) for setup and everyday use.

## User guides

The wiki has two paths:

- **Desktop only:** [setup](wiki/Desktop-Setup.md), [workspace](wiki/Desktop-Workspace.md), [Rime](wiki/Desktop-Rime.md), and [data and troubleshooting](wiki/Desktop-Care.md).
- **Remote / web:** [server setup](wiki/Remote-Web-Setup.md), [integrations](wiki/Remote-Integrations.md), [pairing](wiki/Remote-Access.md), [screen control](wiki/Remote-Screen-Control.md), and [operations](wiki/Remote-Operations.md).

## Technical references

| Reference | Covers |
| --- | --- |
| [Contributing](../CONTRIBUTING.md) | Development setup, validation commands, platform builds, and contribution expectations. |
| [Development workspaces](development-workspaces.md) | Runtime ownership, editor/terminal behavior, conversation routing, sync, proxy configuration, and checks. |
| [Computer control](computer-control.md) | Remote Desktop transport, OS integration, permissions, clipboard/files, and native safety contracts. |
| [Browser downloads](browser-downloads.md) | Placement, authenticated downloads, attachments, limits, and validation evidence. |
| [Browser extensions](browser-extensions.md) | Supported extension installation, persistence, permissions, and provider differences. |
| [Targeted patches](apply-patch.md) | Rime's patch syntax, preflight, ownership, and recovery behavior. |
| [Pages](pages-spec.md) | Page/ward model and workspace design. |
| [Security](../SECURITY.md) | Security boundaries and reporting guidance. |
| [Release notes](releases/0.5.7.md) | Repository notes for that release; see [GitHub Releases](https://github.com/frostdev-ops/rimeward/releases) for published installers and current notes. |

Files named `*-audit.md`, `*-review.md`, `*-follow-up.md`, `*-plan.md`, and `*-acceptance.md` record investigations, plans, or validation at a point in time. They are useful engineering evidence, but are not current installation instructions or promises that every proposed feature shipped.

## Maintaining the wiki

User-guide sources live in `docs/wiki/`; GitHub serves them from its separate `rimeward.wiki.git` repository. Keep `_Sidebar.md` and `_Footer.md` with the pages. Wiki links use GitHub page names without `.md`; open the published wiki for navigation, or the local files above while editing.

Review the source guides with application changes, then publish those reviewed Markdown files to the wiki repository. Preserve unrelated wiki pages and review its diff before pushing. No generated site, extra documentation framework, or application deployment is required.

Screenshots in `docs/goldens/` use disposable demonstration data. Follow the existing `npm run goldens` workflow when changing screenshots or the UI; a prose-only documentation update can reuse the reviewed screenshots.
