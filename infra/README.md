# Vekka infra setup

## MQTT broker auth (mosquitto)

Vekka talks to a local mosquitto broker. As of the auth-hardening work, the
broker requires username/password auth — `allow_anonymous false`. The
credentials are generated automatically by the manager on first boot and
persisted in `auth.json` alongside the web bearer token.

### One-time setup

1. **Install mosquitto**

   ```sh
   brew install mosquitto                # macOS
   sudo apt install mosquitto             # Linux (Debian/Ubuntu)
   ```

2. **Install the Vekka mosquitto config**

   On macOS, drop `infra/mosquitto.conf` into the conf.d directory so it's
   merged with the default config:

   ```sh
   cp infra/mosquitto.conf /opt/homebrew/etc/mosquitto/conf.d/vakka.conf
   ```

   On Linux, edit the paths in `infra/mosquitto.conf` (see comment at the top
   of the file) and copy it to `/etc/mosquitto/conf.d/vakka.conf`.

3. **Start the manager once** so it generates `auth.json` (including
   MQTT creds):

   ```sh
   bun run start
   ```

   Stop it again with Ctrl-C — it can't connect to the broker yet.

4. **Seed the mosquitto password file** with the creds from `auth.json`:

   ```sh
   bun run scripts/mqtt-init.ts
   ```

   The script writes to
   `/opt/homebrew/etc/mosquitto/vakka_passwd` (macOS) or
   `/etc/mosquitto/vakka_passwd` (Linux). Override with
   `VAKKA_MQTT_PASSWD_PATH=/some/path`.

5. **Restart the broker** to pick up the new password file:

   ```sh
   brew services restart mosquitto       # macOS
   sudo systemctl restart mosquitto       # Linux
   ```

### Re-seeding

If `auth.json` is regenerated (e.g. you nuke it during development), repeat
steps 4 and 5.
