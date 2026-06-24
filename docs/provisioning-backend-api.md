# Nimbus Provisioning Backend API

This document describes the REST API that the nimbus snap calls to obtain a
publicly-trusted Let's Encrypt certificate via ACME DNS-01.

You operate this backend against a domain you control (e.g. `api.nimbusappliance.app`).
Each device gets a unique subdomain like `<device-uuid>.devices.nimbusappliance.app`.

---

## Authentication

All endpoints require a bearer token:

```
Authorization: Bearer <NIMBUS_PROVISIONING_TOKEN>
```

The token is set on each device via:

```sh
snap set nimbus provisioning-token=<token>
```

You may use a single shared token for all devices (simple) or issue
per-device tokens (more secure).  Scope all operations by `device_id` to
prevent one device from tampering with another's records.

---

## Endpoints

### POST `/api/v1/devices/register`

Called on every boot.  Registers the device's current LAN IP and returns its
assigned subdomain.

**Request body**

```json
{
  "device_id": "550e8400-e29b-41d4-a716-446655440000",
  "ip":        "192.168.1.50"
}
```

| Field       | Type   | Description                          |
|-------------|--------|--------------------------------------|
| `device_id` | string | Persistent UUID from `$SNAP_COMMON/device-id` |
| `ip`        | string | Current LAN IP of the device         |

**Response `200 OK`**

```json
{
  "domain": "550e8400-e29b-41d4-a716-446655440000.devices.nimbusappliance.app"
}
```

**Backend responsibilities**

1. Upsert DNS A record: `<device-id>.devices.nimbusappliance.app → <ip>`
2. Return the fully-qualified domain name for this device.

---

### POST `/api/v1/acme/challenge`

Called during ACME DNS-01 validation.  The device asks the backend to publish
a `_acme-challenge` TXT record so Let's Encrypt can verify domain ownership.

**Request body**

```json
{
  "device_id": "550e8400-e29b-41d4-a716-446655440000",
  "txt":       "base64url-encoded-sha256-key-authorization"
}
```

| Field       | Type   | Description                                          |
|-------------|--------|------------------------------------------------------|
| `device_id` | string | Device UUID (scopes the DNS record)                  |
| `txt`       | string | Value for `_acme-challenge.<device-id>.devices.nimbusappliance.app` |

**Response `200 OK`**

```json
{ "status": "ok" }
```

**Backend responsibilities**

1. Set DNS TXT record:
   `_acme-challenge.<device-id>.devices.nimbusappliance.app → <txt>`
2. Wait for DNS propagation before returning (or return immediately and rely
   on the device's built-in 20-second sleep).

---

### DELETE `/api/v1/acme/challenge`

Called after ACME validation completes (success or failure) to clean up the
TXT record.

**Request body**

```json
{
  "device_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response `200 OK`**

```json
{ "status": "ok" }
```

**Backend responsibilities**

1. Delete the `_acme-challenge.<device-id>.devices.nimbusappliance.app` TXT record.

---

## DNS record summary

| Record type | Name                                           | Value             | TTL  |
|-------------|------------------------------------------------|-------------------|------|
| A           | `<device-id>.devices.nimbusappliance.app`                | Device LAN IP     | 60 s |
| TXT         | `_acme-challenge.<device-id>.devices.nimbusappliance.app`| ACME key digest   | 60 s |

Use a low TTL (60 s) so IP changes propagate quickly and ACME challenges are
cleaned up fast.

---

## Recommended DNS provider

[Cloudflare](https://cloudflare.com) works well: its API is reliable, TTL
changes take effect in seconds, and the Python `cloudflare` SDK is
straightforward to use.

---

## Environment variables (device side)

| Variable                    | Description                                         | Default  |
|-----------------------------|-----------------------------------------------------|----------|
| `NIMBUS_PROVISIONING_URL`   | Backend base URL, e.g. `https://api.nimbusappliance.app`      | *(unset — self-signed)* |
| `NIMBUS_PROVISIONING_TOKEN` | Bearer token for all backend API calls              | *(unset)* |
| `NIMBUS_ACME_STAGING`       | `1` to use Let's Encrypt staging (testing only)     | `0`      |

Set via snap config:

```sh
snap set nimbus provisioning-url=https://api.nimbusappliance.app
snap set nimbus provisioning-token=<token>
```

---

## First-boot flow (device side)

```
nimbus-launch
  └─ provision_tls()
       ├─ 1. Load or generate persistent device UUID  ($SNAP_COMMON/device-id)
       ├─ 2. POST /api/v1/devices/register  → assigned domain
       ├─ 3. Generate ACME account key + cert key (RSA-2048, cached in $SNAP_COMMON/tls/)
       ├─ 4. Request Let's Encrypt order for <domain>
       ├─ 5. POST /api/v1/acme/challenge  (backend sets TXT record)
       ├─ 6. Sleep 20 s for DNS propagation
       ├─ 7. Answer ACME DNS-01 challenge
       ├─ 8. poll_and_finalize()  (Let's Encrypt validates & issues cert)
       ├─ 9. DELETE /api/v1/acme/challenge  (cleanup)
       └─ 10. Write fullchain to $SNAP_COMMON/tls/nimbus.crt
  └─ uvicorn --ssl-certfile ... --ssl-keyfile ...
```

Cert renewal runs automatically on the next reboot when < 30 days remain.
For long-running deployments, consider adding a periodic renewal cron/timer
outside the snap (e.g. a systemd timer that restarts the snap weekly).
