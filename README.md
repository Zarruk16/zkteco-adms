# ZKTeco ADMS Attendance

Local or cloud server for ZKTeco K20 Pro ADMS push attendance, with a live web UI.

## Local development

```bash
npm install
npm start
```

Open `http://127.0.0.1:8080`. Without `DATABASE_URL`, data is stored in `data/attendance.db` (SQLite).

## Deploy on Railway (free HTTPS URL)

### 1. Push to GitHub

Create a repo and push this project.

### 2. Create Railway project

1. Go to [railway.app](https://railway.app) and sign in.
2. **New Project** → **Deploy from GitHub repo** → select this repo.
3. In the project, click **+ New** → **Database** → **PostgreSQL**.
4. Open your **web service** → **Variables** → add a reference to Postgres:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
5. **Settings** → **Networking** → **Generate Domain** (e.g. `zkteco-adms-production.up.railway.app`).
6. Deploy. Railway runs `npm start` automatically.

### 3. Verify

- Open `https://your-app.up.railway.app` — attendance UI loads.
- `https://your-app.up.railway.app/api/attendance` returns JSON.
- Railway logs show `Database: Postgres (DATABASE_URL)` on startup.

### 4. Point the K20 Pro at Railway

On the device: **Menu → COMM → Cloud Server Setting**

| Setting | Value |
|--------|--------|
| Enable Cloud Server / ADMS | **ON** |
| Domain name | **ON** |
| Server address | `your-app.up.railway.app` (no `https://`) |
| Server port | **443** |
| HTTPS | **ON** (if available) |
| Proxy | **OFF** |

The device must have internet (not guest Wi‑Fi that blocks outbound traffic). Punch once and check Railway logs for `[ATTLOG]`.

### Troubleshooting

- **Device shows connection failed:** confirm server address, port 443, HTTPS on; test device internet.
- **UI works, no punches:** device may not reach Railway; check firewall or try a custom domain later.
- **Postgres SSL errors:** Railway sets `DATABASE_URL` with SSL; the app enables SSL by default.

## Organization manager login

Open `/login` (or `/` — redirects if signed out).

Default credentials (override in production):

- Username: `admin`
- Password: `Admin@2026!`

After login you get the **Organization Dashboard** (`/`) and **Attendance** records (`/attendance`). Device ADMS endpoints (`/iclock/*`) stay open without login.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | Railway sets this | HTTP port (default `8080` locally) |
| `DATABASE_URL` | Railway / Postgres | Use Postgres in production; omit for local SQLite |
| `PGSSLMODE` | Optional | Set to `disable` only for local Postgres without SSL |
| `DEVICE_TZ` | Optional | Timezone the device clock uses for punches (default `UTC`) |
| `DISPLAY_TZ` | Optional | Timezone for UI/CSV times (default `Africa/Lagos`) |
| `LATE_AFTER` | Optional | Late threshold `HH:MM` in display timezone (default `09:00`) |
| `SESSION_SECRET` | Optional | Cookie signing secret |
| `MANAGER_PASSWORD` | Optional | Manager login password (default `Admin@2026!`) |
| `MANAGER_USERNAME` | Optional | Manager login username (default `admin`) |

If check-in times are an hour behind your PC (common when the device/server is on UTC and you are in Nigeria), keep `DEVICE_TZ=UTC` and `DISPLAY_TZ=Africa/Lagos`. If the device menu time already matches your PC, set both to the same value (e.g. `Africa/Lagos`).

## API

- `GET /api/attendance` — daily check-in/out sessions
- `GET /api/attendance.csv` — CSV export
- `GET /api/events` — Server-Sent Events for live UI updates
- `POST /api/sync-users?sn=DEVICE_SN` — queue user name sync from device
- `GET/POST /iclock/*` — ZKTeco ADMS protocol (device only)
