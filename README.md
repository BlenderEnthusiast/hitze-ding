# Stratum — GitHub Pages edition

The building monitor runs directly from a GitHub repository. It includes the previous Atlas and Orion sample GLBs, the fixed Blender sensor positions, a resizable 3D workspace, a day/week/month/year timeline, temperature and humidity graphs, and wall-aware floor maps.

All eight sensors start **offline**. No made-up reading is presented as a real observation.

There is no npm install, build step, paid backend, or running web server to maintain. Python is needed only for the sender and for preparing your own fixed models.

## 1. Put these files in your repository

1. Extract this ZIP completely.
2. On GitHub, create a **public** repository, for example `stratum`. Public repositories support GitHub Pages on GitHub Free.
3. Upload the **contents of this folder** to the repository's `main` branch. `index.html` must be directly at the root, alongside `js`, `vendor`, `models`, `data`, and `config`. Do not upload the ZIP as a single file or leave everything nested inside another folder.
4. Include `.nojekyll` and `.gitignore` if your file picker hides files beginning with a dot. The supplied scripts and paths also work with ordinary Git.
5. Open the repository's **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then **main** and **/(root)**, and press **Save**.
6. Wait for the Pages deployment to complete. Open **Visit site** on that page. A project repository normally appears at `https://YOUR_USERNAME.github.io/stratum/`.

The site automatically detects the owner and repository from a standard `github.io` address. You do not need to edit JavaScript or put a token in the website.

For a custom domain, enter the actual owner and repository in `config/settings.json`, for example:

```json
"github": { "owner": "YOUR_USERNAME", "repo": "stratum", "branch": "sensor-data" }
```

The default data branch is **sensor-data**. Keep Pages publishing from **main**. The Python sender creates `sensor-data` automatically on its first successful upload, based on `main`. It never pushes data to `main`.

## 2. Try it immediately without sensors or a Pi

Open the website and change **Repository feed → Local demo** in the top right.

This generates realistic, time-dependent values and one year of history in the browser. Select **Atlas → Floor 1**, then click a sensor or its inspector row. Choose **Temperature map** or **Humidity map** to see the floor overlay. ENV-004 simulates a warmer room. ENV-008 has intermittent outages.

The local demo does **not** send anything to GitHub. Use the following sender to test the actual repository-to-website path.

## 3. Create a token for the sender

In your own GitHub account:

1. Open **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Choose your account as resource owner, set an expiry, and choose **Only select repositories → stratum**.
3. Set repository permission **Contents → Read and write**. The default metadata permission is sufficient for the remaining reads. No Actions, Pages, or Workflows write permission is needed.
4. Generate the token. Keep it on the Pi or the PC that runs the sender. Do not upload it to the repository or add it to the website configuration.

The app reads public JSON without authentication. Only the sender uses this token to write commits.

## 4. Publish realistic test data from a Raspberry Pi

Use Raspberry Pi OS with Python **3.9 or newer**, internet access, and a correct system clock. Copy the extracted folder onto the Pi, or clone your new repository:

```bash
git clone https://github.com/YOUR_USERNAME/stratum.git
cd stratum
```

Set your token for this terminal session. The first command hides what you type:

```bash
read -rsp "GitHub token: " GITHUB_TOKEN
echo
export GITHUB_TOKEN
```

Publish one test snapshot, optionally including a year of hourly simulated history:

```bash
python3 raspberrypi/publish.py --repo YOUR_USERNAME/stratum --demo --once --seed-days 365
```

Then start continuous test updates:

```bash
python3 raspberrypi/publish.py --repo YOUR_USERNAME/stratum --demo
```

Leave that command running. It publishes one batch for **all sensors every five minutes**. The first update is immediate. Your website's **Repository feed** mode checks every **30 seconds** and updates readouts, markers, graphs, and maps without reloading the page or the GLBs. Press ↻ to check immediately. GitHub's raw-file caching can add delivery delay; this is a periodically updated dashboard, not a guaranteed low-latency stream.

The `--seed-days` option is only for a one-off demo backfill. Ordinary operation appends history automatically. Stop the sender with Ctrl+C. Values expire by themselves when updates stop.

### Test from your Windows PC instead

Python 3.9+ works on Windows as well. For the demo's Europe/Berlin timezone, install `tzdata` if Windows has no timezone database:

```powershell
py -m pip install tzdata
```

Open PowerShell in this extracted folder, then run:

```powershell
$stratumToken = Read-Host "GitHub token" -AsSecureString
$env:GITHUB_TOKEN = [System.Net.NetworkCredential]::new("", $stratumToken).Password
py raspberrypi/publish.py --repo YOUR_USERNAME/stratum --demo --once --seed-days 365
py raspberrypi/publish.py --repo YOUR_USERNAME/stratum --demo
```

The Pi is not required for this test. The website sees the same published JSON.

## 5. Switch to real sensor data

Stop the demo publisher first. Run **one publishing gateway** for this registry.

Your Pi's receiver should keep a local JSON file, for example `raspberrypi/readings.json`, containing its complete current sensor snapshot. Use this format:

```json
{
  "sensors": [
    {
      "sensor_id": "ENV-001",
      "online": true,
      "received_at": "2026-11-09T12:00:00Z",
      "temperature": 22.7,
      "humidity": 46.2
    },
    {
      "sensor_id": "ENV-002",
      "online": false,
      "received_at": null,
      "temperature": null,
      "humidity": null
    }
  ]
}
```

`temperature` is your warmth reading in **°C**. `humidity` is **relative humidity in percent**, from 0 to 100. `online` is a real JSON boolean. An online observation requires a timezone-aware timestamp, using `Z` or an explicit offset.

Use the **time the Pi received that particular measurement** as `received_at`. Keep that timestamp unchanged if no new reading arrives; repeatedly publishing the same file cannot make an old reading fresh. Replace the example timestamp above with the real reception time.

The example is a complete gateway snapshot: registered sensors omitted from the file are marked offline. IDs must exactly match `data/sensors.json`. Use a temporary file followed by an atomic rename when your receiver updates JSON. Invalid JSON or invalid values do not overwrite the last published snapshot.

Run:

```bash
python3 raspberrypi/publish.py --repo YOUR_USERNAME/stratum --input raspberrypi/readings.json
```

The program rereads that file each cycle. A sensor goes offline if its observation is over **15 minutes** old by default, or if `online` is false. If the entire Pi stops publishing, the website also expires its snapshot automatically. Offline readouts show dashes; they never silently substitute demo values.

To explicitly mark all sensors offline once:

```bash
python3 raspberrypi/publish.py --repo YOUR_USERNAME/stratum --offline --once
```

No hardware protocol is assumed. Your receiver may collect data over MQTT, ESP-NOW via a bridge, serial, BLE, or another interface; its output just needs to match the JSON contract above.

## 6. Start automatically on the Pi (optional)

1. Create `~/.config/stratum.env` **outside** the repository:

   ```text
   GITHUB_TOKEN=YOUR_TOKEN
   STRATUM_REPO=YOUR_USERNAME/stratum
   ```

2. Restrict that file:

   ```bash
   chmod 600 ~/.config/stratum.env
   ```

3. Edit the supplied `raspberrypi/stratum-publisher.service`: replace **every** `YOUR_PI_USER` and adjust the checkout path. Its `ExecStart` starts the demo; for real data replace `--demo` with `--input /home/YOUR_PI_USER/stratum/raspberrypi/readings.json`.
4. Install and start it:

   ```bash
   sudo cp raspberrypi/stratum-publisher.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now stratum-publisher
   journalctl -u stratum-publisher -f
   ```

Your receiver must run independently and refresh its input file. The publisher service reads it; it does not operate the sensors itself.

## Your own buildings and sensor positions

The included GLBs are the **sample buildings**, not your large private building models. Install your fixed assets before uploading the final site:

```text
models/all/BUILDING/FLOOR/model.glb
data/sensors.json
```

Several GLBs or local-buffer glTFs may live in one floor directory. Keep shared world coordinates and standard glTF Y-up export. Registry positions remain **Blender world XYZ, Z up, metres**; the viewer converts them to glTF `(x, z, -y)`. Building and floor identifiers must exactly match their directory names. There is no runtime model-import UI.

After replacing models or moving sensors, run on your PC:

```bash
python3 tools/prepare_models.py
```

On Windows use `py tools/prepare_models.py`. No extra Python packages are needed for this preparation. Upload the updated models, sensor registry, `models/manifest.json`, and `data/maps/` to `main`. The generator discovers the fixed folder hierarchy, calculates world-space bounds, projects floor triangles, slices the walls at sensor height, and writes the floor rasters. The browser cannot list server directories, so regenerate the manifest whenever you change the installed hierarchy.

Use triangulated, **uncompressed** glTF/GLB geometry for this bundled map-preparation path. External buffers and textures must remain alongside their model. The viewer loads selected-scope geometry on demand and disposes geometry outside that scope; All buildings still intentionally loads all visible floors. Data updates never reload the models.

**Large-model limit:** GitHub blocks ordinary Git files above **100 MiB**, browser uploads are limited to **25 MiB per file**, and a published Pages site is limited to **1 GB**. Optimize or split any individual GLB that exceeds those limits. Splitting alone does not reduce total download size or GPU usage. GLB optimization is not applied to private assets that were not supplied in this package.

## How data reaches the page

| Part | Location | Behavior |
|---|---|---|
| Website and fixed assets | `main` branch | Served by GitHub Pages |
| Latest snapshot | `sensor-data:data/live.json` | One entry per registered sensor |
| Real history | `sensor-data:data/history/real/YYYY-MM.json` | Actual measurements, compact monthly files |
| Test history | `sensor-data:data/history/simulated/YYYY-MM.json` | Explicitly simulated; never merged with real history |
| Writer token | Environment on Pi/PC | Used only by the Python publisher |

The page reads the data branch through `raw.githubusercontent.com`. Sensor uploads make atomic commits containing the latest snapshot and any changed archive files. Branch-head conflicts retry against the new head with no force push. Keeping uploads on a separate branch avoids rebuilding Pages for every measurement.

The latest snapshot retains every published value. Persistent history keeps the **first observation per 15-minute UTC bucket**, plus offline/online transitions; optional demo backfill is hourly. The page requests the relevant monthly archives for the chosen timeline interval. Historical readouts select the last actual observation at or before the playhead, with no interpolated measurement values. Gaps and explicit offline observations break the graph. Simulated hourly history uses a longer historical expiry so that the generated hourly samples remain usable.

The default five-minute upload interval suits a small school dashboard. Git repositories accumulate history; use an actual time-series service if you later need high-frequency or large-scale logging. No scheduled GitHub Action is needed, and uploads do not consume Pages builds.

## Map calculation and limits

The solver discretizes `div(k × grad(u)) = 0` with finite-volume flux balance, harmonic face conductances, fixed sensor readings, and insulated exterior edges. A preconditioned conjugate-gradient solve runs in a Web Worker. Air has relative conductance 1; wall pixels default to 0.035 for temperature and 0.005 for humidity. These are configurable **relative assumptions**, not measured wall material properties.

The footprint comes from projected slab geometry, preserving holes and courtyards. A closed wall outline can also define a footprint. Modeled walls reduce influence across them, and doors modeled open provide lower-resistance paths. Furniture intersecting the slicing height can also act as an obstruction. Areas with no connected sensor stay transparent.

The overlay is one continuously filtered texture, not a visibly triangulated color mesh. Temperature uses **blue → green → red**, humidity **green → blue**, scaled consistently to the fresh readings across all visible floors. A uniform temperature is green. One available sensor gives a constant estimate across its connected footprint.

This is a **spatial estimate**, not calibrated building thermodynamics or CFD. The app does not know HVAC, airflow, exterior boundary temperatures, wall materials, or vapor sources. Humidity is treated as a scalar diffusion field; true moisture transport would require vapor pressure, temperature, and boundary conditions. Real measurements remain distinct from all map estimates.

Browsers with WebGL2 render the GLBs in 3D. If WebGL is unavailable, a top-down Canvas floor plan keeps sensor selection, maps, charts, and the timeline usable.

## Controls

| Input | Effect |
|---|---|
| Select floor | Isolate that floor; its sensor markers become visible through walls |
| Click sensor | Focus it and show both histories |
| Middle drag / Shift + middle drag | Orbit / pan in 3D |
| Scroll | Zoom |
| Right drag | Pan |
| Home / Numpad decimal | Frame scope / focus selected sensor |
| Numpad 1 / 3 / 7 / 5 | Front / side / top / switch projection |
| Drag timeline | Seek history |
| Middle or right drag timeline / scroll | Pan / zoom the interval |
| Hover graph / click graph | Inspect actual sample / seek to it |
| LIVE | Return to now |
| Panel dividers | Resize panes; saved in this browser |

## Local preview and checks

From the extracted folder:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/`. Opening `index.html` as a `file://` URL does not support module and JSON loading. To test the complete publishing path locally, run from a second terminal:

```bash
python3 raspberrypi/publish.py --demo --local . --once --seed-days 3
```

This changes your **local** `data/` files. Keep the original offline `data/live.json` if you want the uploaded site to start offline. No token or GitHub request is used in `--local` mode.

Development checks (Node 20+ for JS tests; Python 3.9+):

```bash
node --test tests/*.test.js
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Validation covers snapshot expiry, malformed input, truthful reception times, separated real/test archives, atomic Git commits and conflict retries, calendar boundaries, history selection, analytic diffusion solutions, wall resistance, and disconnected footprints. The dashboard, Canvas fallback, maps, and charts were exercised in a browser. That test browser had WebGL disabled, so hardware 3D rendering and an authenticated GitHub upload remain to be verified in your environment.

## Troubleshooting

- **Page is a README instead of the app:** `index.html` is nested, missing, or Pages points at the wrong branch/folder. Use `main / (root)`.
- **Waiting for first Pi upload:** run the sender successfully once. It creates the data branch; the initial site remains offline until then.
- **HTTP 401/403/404 from the sender:** check token expiry, selected repository, resource owner, Contents write access, organization approval if applicable, and `OWNER/REPO`. A protected data branch may reject direct updates; give the sender a writable data branch.
- **HTTP 422 on the first upload:** verify `main` exists and contains at least one commit. If your site branch has another name, pass `--site-branch NAME`.
- **Sensors go offline despite uploads:** the sensor-specific `received_at` is old, the receiver stopped refreshing its JSON, or a clock is wrong.
- **Real values were replaced by tests:** stop all demo senders before running the real-data sender. Use one gateway process.
- **Markers are misplaced:** check Blender world coordinates, metres, shared glTF export transforms, and exact building/floor identifiers; rerun model preparation after edits.
- **No map:** show a floor with fresh readings and a prepared footprint. One unsupported compressed GLB can prevent map preparation.
- **Windows says `No time zone found`:** `py -m pip install tzdata`.
- **No new values immediately after upload:** allow for polling and GitHub cache delay, or press refresh. Check that your source is Repository feed, not Local demo.

## License and primary references

Application code and inherited/generated sample assets: **GPL-3.0**, see `LICENSE`. Vendored **Three.js 0.180.0**: MIT, see `vendor/three/LICENSE`. All JavaScript needed to run is included; no CDN dependency is required.

- [Configure GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [Large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)
- [GitHub Git database API](https://docs.github.com/en/rest/git)
- [Fine-grained token permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)

## Updated visibility

Sensors appear in every view whenever their floor is visible. In building and campus views, walls and other geometry occlude both the marker and its label, and occluded markers cannot be selected through walls. Selecting a floor enables visibility and selection through walls for its sensors. The chosen temperature or humidity overlay is calculated independently for every visible floor, using one shared color scale. Hidden floors have neither markers nor overlays.

### Updating an existing repository

Upload `js/`, `vendor/`, and `index.html` from this ZIP over the corresponding files in your existing main branch. This includes the new `js/overlays.js`. Your installed models, sensor registry, data feed, and configuration do not need replacement. Optional updated regression tests are in `tests/visibility.test.js`.

## Slower camera motion

Sensor focus, framing, and aligned view changes now ease in and out over 1.4 seconds. Scroll zoom uses smaller steps and settles gradually; orbit and pan have gentler sensitivity and damping. Orthographic framing also eases the view scale. New input interrupts automatic movement. The operating system reduced-motion preference keeps focus and zoom immediate.

For this animation update, upload the complete `js/` folder, including the new `js/motion.js`. The full ZIP also includes the latest sensor visibility and multi-floor overlay changes.
