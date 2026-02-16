# REAINO MVP Demo

A 3-minute scripted demo of the REAINO digital twins platform for ebm-papst cabinet cooling.

## Features

- **3-pane UI**: Projects & Twins | Tasks & Workflow | Review & KPIs
- **7-agent pipeline**: Spec → Topology → Connector → Derived Signal → KPI → View → Validation
- **Live data bus activity**: Modbus TCP, MQTT, TimescaleDB events
- **AR/VR Viewer Mode**: Pop-out overlay with KPI labels
- **Deploy workflow**: Draft → Staging → Production

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server
npm run dev
```

Then open http://localhost:5173 in your browser.

## Build for Production

```bash
npm run build
npm run preview
```

## Tech Stack

- React 18 + TypeScript
- Vite 5
- Tailwind CSS 3.4

## Demo Behavior

The demo runs a 180-second (3-minute) scripted sequence:
1. Prompt is "typed" into the input box
2. Agents progress through stages, emitting artifacts
3. Data bus activity scrolls in real-time
4. KPIs populate and stabilize with confidence scores
5. Validation passes, enabling deploy to staging/production

Use **Pause/Reset** buttons to control the demo, and **Open AR/VR Viewer** to see the overlay mode.
