# n8n Community Edition SSO Demo

[![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![nginx](https://img.shields.io/badge/nginx-%23009639.svg?style=for-the-badge&logo=nginx&logoColor=white)](https://nginx.org/)
[![Keycloak](https://img.shields.io/badge/Keycloak-4D4D4D?style=for-the-badge&logo=keycloak&logoColor=white)](https://www.keycloak.org/)
[![n8n](https://img.shields.io/badge/n8n-FF6D5A?style=for-the-badge&logo=n8n&logoColor=white)](https://n8n.io/)

A complete **Single Sign-On (SSO)** demonstration for **n8n Community Edition** using Docker Compose. The stack integrates LDAP, Keycloak, nginx with oauth2-proxy, and automatic user provisioning in n8n via external hooks.

> **Inspired by:** [n8n & Authelia - Bypass n8n native login page using Trusted Header Single Sign-On](https://kb.jarylchng.com/i/n8n-and-authelia-bypass-n8n-native-login-page-usin-sNRmS-7j5u1/) by Jaryl Chng.

---

## Table of Contents

- [Solution Architecture](#solution-architecture)
- [Authentication Flow](#authentication-flow)
- [Components](#components)
- [Quick Start](#quick-start)
- [Security](#security)
- [Logout](#logout)
- [Default Credentials](#default-credentials)
- [Troubleshooting](#troubleshooting)
- [Production Considerations](#production-considerations)
- [Version Compatibility](#version-compatibility)
- [Environment Variables Reference](#environment-variables-reference)
- [Additional Information](#additional-information)
- [Summary](#summary)
- [Contributing](#contributing)
- [License](#license)

---

## Solution Architecture

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────────┐    ┌────────────────┐
│     Browser     │───▶│    Nginx     │───▶│  oauth2-proxy   │───▶│   Keycloak     │
│                 │    │ (Reverse     │    │ (OAuth2/OIDC    │    │  (Identity     │
│                 │    │  Proxy)      │    │   Client)       │    │   Provider)    │
└─────────────────┘    └──────────────┘    └─────────────────┘    └────────────────┘
                                ▲                                           │
                                │                                           ▼
                        ┌───────────────┐                       ┌──────────────────┐
                        │      n8n      │                       │      LDAP        │
                        │  (Workflow    │                       │  (User Store)    │
                        │   Engine)     │                       │                  │
                        └───────────────┘                       └──────────────────┘
```

## Authentication Flow

1. **User** opens `http://localhost` → **nginx**.
2. **nginx** performs `auth_request` to **oauth2-proxy**.
3. If unauthenticated, **oauth2-proxy** redirects to **Keycloak**.
4. **Keycloak** authenticates against **LDAP**.
5. On success, **oauth2-proxy** returns to nginx and exposes trusted headers.
6. **nginx** forwards to **n8n** with:
    - `Remote-Email` (email)
    - `Authorization` (JWT with claims)
    - `X-Auth-Request-Access-Token` (access token)
7. **n8n hook** reads headers, decodes the JWT for `firstName`/`lastName`, auto-creates user if needed, and issues the session cookie.

---

## Components

### 1) LDAP Server (osixia/openldap)
- **Port:** 389
- **Admin:** `cn=admin,dc=example,dc=org` / `admin`
- **Demo user:** `jdoe` / `password` (email `jdoe@example.org`)

### 2) Keycloak (Identity Provider)
- **Port:** 8080
- **Admin UI:** `http://localhost:8080` (`admin` / `admin`)
- **Realm:** `demo`
- **LDAP federation** with attribute mappers for username, email, firstName, lastName
- **OIDC client:** `oauth2-proxy`
- **Key settings:** `verifyEmail: false`, `trustEmail: true`

### 3) oauth2-proxy (OAuth2/OIDC Client)
- **Port:** 4180 (internal)
- **Provider:** Keycloak OIDC
- **Headers set:** `X-Auth-Request-Email`, `X-Auth-Request-User`, `X-Auth-Request-Access-Token`, `Authorization`
- **Key flags:**
    - `OAUTH2_PROXY_SKIP_OIDC_EMAIL_VERIFICATION=true`
    - `OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true`
    - `OAUTH2_PROXY_WHITELIST_DOMAINS=localhost`
    - `OAUTH2_PROXY_SET_XAUTHREQUEST=true`

### 4) nginx (Reverse Proxy)
- **Port:** 80
- **Pattern:** `auth_request`
- **Responsibilities:**
    - Enforces auth via oauth2-proxy
    - **Security:** strips client-supplied sensitive headers and sets trusted headers only after successful auth
    - Proxies to n8n with WebSocket support

### 5) n8n (Workflow Engine)
- **Ports:** 5678 (direct), 80 (via nginx)
- **External hook:** auto-provisions users from trusted headers/JWT
- **Data sources:**
    - Email → `Remote-Email`
    - Names → JWT (`given_name`, `family_name`)
- **Env:**
    - `EXTERNAL_HOOK_FILES=/home/node/.n8n/hooks.js`
    - `N8N_FORWARD_AUTH_HEADER=Remote-Email`

---

## Quick Start

### Requirements
- Docker (or Docker Desktop) with Docker Compose
- Open ports: 80, 389, 5678, 8080

### Setup
```bash
git clone <this-repo>
cd n8n-community-sso
docker compose up -d
```

### Readiness Checks
```bash
docker compose ps
curl -s http://localhost:8080/realms/demo/.well-known/openid-configuration | head -c 100
docker compose logs keycloak
docker compose logs oauth2-proxy
docker compose logs n8n
```

### Test the SSO Flow
1. Open **http://localhost**
2. Login with **Keycloak** credentials
    - **Username:** `jdoe`
    - **Password:** `password`
3. You’ll be redirected to **n8n**, where the user is auto-created with full name from LDAP.

---

## Security

### Header Injection Protection (nginx)
nginx is configured to prevent client header injection:

```nginx
# Strip any client-provided sensitive headers
proxy_set_header Remote-Email "";
proxy_set_header Authorization "";
proxy_set_header X-Auth-Request-Access-Token "";

# Set trusted headers only after successful authentication
auth_request_set $email         $upstream_http_x_auth_request_email;
auth_request_set $access_token  $upstream_http_x_auth_request_access_token;
auth_request_set $auth_header   $upstream_http_authorization;

proxy_set_header Remote-Email                $email;
proxy_set_header X-Auth-Request-Access-Token $access_token;
proxy_set_header Authorization               $auth_header;
```

**Principles**
1. nginx never forwards sensitive headers from the client.
2. Headers are set only after a successful `auth_request`.
3. oauth2-proxy validates tokens with Keycloak and exposes JWT with claims.
4. Keycloak authenticates against LDAP and includes email + names in JWT.
5. The n8n hook decodes JWT to provision/update users.

---

## Logout

- **Unified logout:** `http://localhost/logout`
    1) Clears the n8n cookie
    2) Redirects through oauth2-proxy logout
    3) Initiates Keycloak logout
- **Manual endpoints:**
    - n8n: `http://localhost/logout`
    - Keycloak: `http://localhost:8080/realms/demo/protocol/openid-connect/logout`

---

## Default Credentials

**LDAP**
- Admin: `cn=admin,dc=example,dc=org` / `admin`
- Demo user: `jdoe` / `password` (`jdoe@example.org`)

**Keycloak**
- Admin: `admin` / `admin`
- Realm: `demo`
- Client: `oauth2-proxy` / `oauth2proxysecret`

**n8n**
- Users are auto-created on first login
- Default role: `global:member`

---

## Troubleshooting

**oauth2-proxy keeps restarting**
```bash
docker compose logs oauth2-proxy
# Often means Keycloak isn't ready yet.
```

**Keycloak slow to start**
```bash
curl -s http://localhost:8080/realms/demo/.well-known/openid-configuration
```

**500 during callback**
- Typically due to unverified email.
- Fixed with `OAUTH2_PROXY_SKIP_OIDC_EMAIL_VERIFICATION=true` and Keycloak `verifyEmail: false`.

**n8n didn’t create the user**
```bash
docker compose logs n8n | grep -i "sso\|Remote-Email"
# Verify that headers reach n8n.
```

**502 Bad Gateway**
```bash
docker compose ps
# Ensure all services are Up.
```

**Invalid redirect errors**
- Fixed with `OAUTH2_PROXY_WHITELIST_DOMAINS=localhost`.

**Full reset (demo data is ephemeral)**
```bash
docker compose down -v
docker compose up -d
```

**Header debugging (optional)**  
Use an echo service (`ealen/echo-server`) temporarily and point nginx to it to inspect headers.

---

## Production Considerations

**HTTPS everywhere**
- TLS certs in nginx, switch all URLs to `https://`.

**Security**
- Rotate all default credentials.
- Strong cookie secrets.
- Proper firewall rules and logging.

**Persistence**
- External DBs (PostgreSQL).
- Volumes for n8n workflow data and cache.
- Backups for Keycloak and n8n data.

**Monitoring**
- Health checks, structured logs, metrics/alerts.

**Scalability**
- External DBs, load balancers, Redis for sessions if needed.

---

## Version Compatibility

- **Latest tested:** **n8n v1.112.6**
    - This demo includes a **compatibility fix** for changes introduced in `1.112.6` where cookie issuance internally dereferences fields on the user’s **role** (e.g., `role.slug`).
    - The provided external hook now **ensures the user’s role is loaded/attached** before issuing the cookie and sets `app.set('trust proxy', 1)` for correct `X-Forwarded-*` handling behind a reverse proxy.

- Previously tested: **n8n v1.102.4** (older version of this demo)

> If you maintain your own custom hook, make sure that when calling cookie issuance helpers, the `user` entity includes a valid `role` relation.

---

## Environment Variables Reference

### n8n
```bash
EXTERNAL_HOOK_FILES=/home/node/.n8n/hooks.js
N8N_FORWARD_AUTH_HEADER=Remote-Email
N8N_BASIC_AUTH_ACTIVE=false
N8N_USER_MANAGEMENT_DISABLED=false
```

### oauth2-proxy
```bash
OAUTH2_PROXY_PROVIDER=oidc
OAUTH2_PROXY_OIDC_ISSUER_URL=http://keycloak:8080/realms/demo
OAUTH2_PROXY_CLIENT_ID=oauth2-proxy
OAUTH2_PROXY_CLIENT_SECRET=oauth2proxysecret
OAUTH2_PROXY_SKIP_OIDC_EMAIL_VERIFICATION=true
OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true
OAUTH2_PROXY_WHITELIST_DOMAINS=localhost
OAUTH2_PROXY_SET_XAUTHREQUEST=true
OAUTH2_PROXY_SET_XAUTHREQUEST_HEADERS=X-Auth-Request-Email,X-Auth-Request-User,X-Auth-Request-Access-Token
OAUTH2_PROXY_PASS_ACCESS_TOKEN=true
OAUTH2_PROXY_PASS_AUTHORIZATION_HEADER=true
OAUTH2_PROXY_SET_AUTHORIZATION_HEADER=true
OAUTH2_PROXY_OIDC_EXTRA_AUDIENCES=oauth2-proxy
OAUTH2_PROXY_EXTRA_JWT_ISSUERS=http://keycloak:8080/realms/demo=oauth2-proxy
```

---

## Additional Information

**Useful links**
- [n8n Docs](https://docs.n8n.io/)
- [Keycloak Docs](https://www.keycloak.org/documentation)
- [oauth2-proxy Docs](https://oauth2-proxy.github.io/oauth2-proxy/)
- [nginx `auth_request` module](http://nginx.org/en/docs/http/ngx_http_auth_request_module.html)

**Configuration files**
- `docker-compose.yaml` – service orchestration and volumes
- `nginx/nginx.conf` – reverse proxy with `auth_request`
- `keycloak/realm-export.json` – realm with LDAP federation/mappers
- `ldap/bootstrap.ldif` – demo LDAP users
- `hooks.js` – n8n external hook for automatic provisioning

**Data management (demo)**
- n8n cache: Docker volume (cleared with `down -v`)
- LDAP/Keycloak: ephemeral for testing

**Component versions (example)**
- **n8n:** `v1.112.6` (latest tested)
- **Keycloak:** `24.0.1`
- **oauth2-proxy:** `v7.7.1`
- **nginx:** `alpine`
- **OpenLDAP:** `1.5.0`

---

## Summary

This demo shows an end-to-end SSO integration for n8n CE:

- **LDAP** as the user source with attribute mapping
- **Keycloak** as IdP (email verification disabled; trustEmail enabled)
- **oauth2-proxy** as the OIDC client with unverified email support
- **nginx** as a secure reverse proxy using `auth_request`
- **Automatic user provisioning** in n8n via external hooks (names from JWT)
- **Hardened header handling** and a **compatibility fix for n8n 1.112.6**
- One command to start: `docker compose up -d`

**Test quickly:**
1) open `http://localhost` → 2) login `jdoe/password` → 3) n8n user is created with email, first/last name, and `global:member` role.

---

## Contributing

PRs are welcome! For major changes, please open an issue first.

### Dev setup
1. Fork
2. `git checkout -b feature/AmazingFeature`
3. Commit & push
4. Open a PR

### Reporting issues
Use **GitHub Issues** to report bugs and request features.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
