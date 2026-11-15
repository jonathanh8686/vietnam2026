# vietnam2026

Trip site for Vietnam, November 19–28, 2026 — Ho Chi Minh City → Ninh Binh → Hanoi.

Static site, no build step. Live at https://vietnam.jonathanhsieh.dev.

## Structure

- `index.html` — trip hub: countdown, route map, to-do checklist, links
- `itinerary.html` — day-by-day itinerary
- `housing.html` — booked housing for HCMC and Hanoi, plus the arrival-night hotel
- `css/style.css` — shared styles
- `js/main.js` — countdown timer
- `js/map.js` — Leaflet route map

## Local preview

```
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Deployment

Push to `main` — the site updates within about a minute. No manual step.

How it works, on the `omashu` GCE VM (`gcloud compute ssh omashu --project=omashu-420807 --zone=us-central1-a`):

- Apache vhost `vietnam.jonathanhsieh.dev` (HTTPS via Let's Encrypt/certbot) serves `/var/www/vietnam2026`, a symlink to the git clone at `/home/jonathanh1386/vietnam2026`.
- `vietnam2026-deploy.timer` runs `vietnam2026-deploy.service` every minute, which does `git fetch` + `git merge --ff-only origin/main` in that clone as `jonathanh1386`.
- `/etc/apache2/conf-enabled/block-git.conf` returns 404 for any `/.git` path.

Never edit files or run git with `sudo` in the server clone — root-owned files break the pull. If a deploy seems stuck:

```
sudo journalctl -u vietnam2026-deploy.service -n 20
```
