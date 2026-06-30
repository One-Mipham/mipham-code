---
name: om-artifact
description: Mipham Artifacts — create interactive HTML/SVG dashboards, reports, and visualizations the user can view in their browser
version: 1.0.0
---

# Mipham Artifacts Skill

Create interactive browser-viewable artifacts from conversation output. Use the `Artifact` tool to save standalone HTML or SVG files that the user opens with `/artifact open <name>`.

## When to Use Artifact vs Write

| Artifact                                     | Write                                            |
| -------------------------------------------- | ------------------------------------------------ |
| Visual output (charts, dashboards, diagrams) | Source code files                                |
| Interactive HTML demos                       | Configuration files                              |
| Styled reports with CSS                      | Documentation (.md)                              |
| SVG graphics and visualizations              | Data files (.json, .csv)                         |
| Anything the user wants to SEE in a browser  | Anything the user wants to EDIT in a text editor |

**Ask yourself**: "Would this be better viewed in a browser than in a terminal or text editor?" If yes, use Artifact.

## Artifact Guidelines

### Content Requirements

- **Self-contained only**: All CSS and JS must be inline. No CDN links, no external fonts, no network requests. The CSP policy blocks all external resources.
- **Size limit**: 5MB maximum. Aim for under 500KB for good performance.
- **Artifact types**: `html` (full HTML pages) or `svg` (standalone SVG graphics)

### Naming

- Use short kebab-case names: `user-dashboard`, `pipeline-diagram`, `pr-diff-review`
- The name becomes the filename: `user-dashboard.html`

### Styling

- Use inline `<style>` blocks in the HTML head
- Dark theme recommended (matches Mipham Code aesthetic)
- Responsive design where practical
- Clean, professional look — this is user-facing output

## Good Artifact Examples

1. **Data dashboard**: Query results rendered as tables, charts (inline Chart.js data via canvas), metrics cards
2. **Diff viewer**: Side-by-side code comparison with syntax highlighting
3. **Report**: Structured markdown rendered as styled HTML with TOC
4. **Timeline**: Event sequence visualization with expandable sections
5. **Network graph**: Interactive node-edge visualization (D3 or vis.js inline)
6. **Architecture diagram**: Components and connections with color coding
7. **Test results**: Pass/fail grid with expandable failure details

## Artifact Lifecycle

1. AI creates artifact via `Artifact` tool → saved to `.mipham/artifacts/<session>/<name>.html`
2. Tool returns the localhost URL
3. User opens with `/artifact open <name>` → browser displays it
4. User lists all artifacts with `/artifact list`
5. Server runs on `http://localhost:9876` by default

## Prompting the User

After creating an artifact, always tell the user:

- The artifact name
- The URL
- That they can open it with `/artifact open <name>`

Example: "I've created a dashboard artifact. Open it with `/artifact open dashboard`"
