# SIM7600EI Cellular Gateway

A high-reliability, standalone cellular gateway for the **SIMCOM SIM7600EI** LTE modem with mock hardware emulation, audio diagnostics, and pluggable AI voice interfaces.

## System Overview

- **Gateway Backend (`packages/gateway`)**: Node.js + TypeScript service managing AT commands, exclusive COM port locking (`COM14` AT, `COM13` audio), call sessions, and SQLite persistence.
- **Shared Contracts (`packages/shared`)**: Single source of truth for TypeScript interfaces, Zod validation schemas, and Socket.IO events.
- **Modern Dashboard (`packages/dashboard`)**: Next.js + Tailwind CSS + shadcn/ui dark UI for call monitoring and gateway telemetry.

## Quick Start (Mock Mode on macOS)

```bash
# Install dependencies across all packages
npm install

# Build shared package
npm run --workspace=@sim-gateway/shared build

# Start Gateway backend with mock modem adapter
npm run dev:gateway

# In a separate terminal, launch the dashboard
npm run dev:dashboard
```

## Documentation

- [Architecture Specification](docs/ARCHITECTURE.md)
- [REST API & Socket.IO Reference](docs/API.md)
- [Phased Implementation Plan](docs/IMPLEMENTATION_PLAN.md)
- [Mock Modem Adapter Design](docs/MOCK_MODEM_DESIGN.md)
- [Windows Hardware Integration & Validation](docs/WINDOWS_HARDWARE_INTEGRATION.md)
- [Test Strategy](docs/TEST_STRATEGY.md)

## Dashboard Features (Phase 3)

The dashboard is built with **Next.js 14**, **Tailwind CSS**, and **Socket.IO Client** with a dark-first infrastructure design:

- **Gateway Overview (`/`)**: Real-time gateway connectivity status, modem telemetry (model, firmware, SIM status), carrier & signal RSSI indicators, active call panel with live 16-segment audio VU meters (RX/TX RMS), simulated inbound trigger, and recent calls table.
- **Cellular Dialer (`/dialer`)**: E.164 phone number validation, dial pad, in-call DTMF tone transmission, and full lifecycle call controls (Answer, Hangup, DTMF).
- **Call History (`/calls`)**: Paginated SQLite call logs, outcome badges (`completed`, `busy`, `no_answer`, `failed`), duration formatting, simulation markers, and a detailed call modal with an event timeline.
- **Settings & Security (`/settings`)**: Configurable gateway endpoint and API key saved to browser `localStorage` (never baked into production builds), live connection ping test, and deployment instructions for Mac-to-Windows LAN access.

## Running the Application

### 1. Prerequisites & Installation
```bash
# Clone the repository and install all dependencies
npm install

# Build shared contracts
npm run --workspace=@sim-gateway/shared build
```

### 2. Running the Gateway Backend (Port 4000)
```bash
# Run in development mode with hot-reloading (uses mock modem by default)
npm run dev:gateway
```
*Health endpoint available at:* `http://localhost:4000/api/gateway/health`

### 3. Running the Dashboard (Port 3000)
```bash
# In a separate terminal, start the Next.js dev server
npm run dev:dashboard
```
*Open:* `http://localhost:3000`

### 4. Running Automated Tests & Production Build
```bash
# Run all 42 unit & integration tests across both backend and dashboard
npm run --workspace=@sim-gateway/gateway test && npm run --workspace=@sim-gateway/dashboard test

# Run production build across all workspaces
npm run build
```

## Security & Mac-to-Windows Deployment
- The Gateway API uses Bearer token authorization (`Authorization: Bearer <GATEWAY_API_KEY>`).
- Client credentials configured via the Dashboard UI are stored strictly in client-side `localStorage` and sent over authenticated HTTP headers and Socket.IO handshakes.
- When hosting the Gateway on a Windows PC with physical hardware:
  1. Set `HOST=0.0.0.0` and a strong `GATEWAY_API_KEY` in the Windows host `.env`.
  2. Set `CORS_ORIGIN=http://<MAC_IP>:3000` to prevent unauthorized cross-origin requests.
  3. Ensure Windows Defender firewall allows incoming TCP traffic on port 4000 from the local subnet.
  4. In the Dashboard on macOS (`/settings`), set the Gateway URL to `http://<WINDOWS_IP>:4000` and enter the corresponding API key.

