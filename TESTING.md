# Testing Steps

## 1. Pull the latest changes

```bash
git pull
```

## 2. Stop and restart all containers with fresh volumes

```bash
# Stop and remove everything (including volumes)
docker compose down -v

# Start fresh
docker compose up -d

# Wait about 30 seconds for all services to be ready
```

## 3. Monitor the logs

```bash
# Watch n8n logs in real-time
docker compose logs -f n8n
```

## 4. Test the SSO flow

1. Open **http://localhost** in a new private/incognito browser window
2. Login with:
   - Username: `jdoe`
   - Password: `password`
3. You should be automatically logged into n8n

## 5. What to look for in the logs

If working correctly, you should see:
- `SSO middleware initializing with header: Remote-Email`
- `No instance owner set up yet. First SSO user will become the owner.`
- `SSO auto-login attempt for email: jdoe@example.org`
- `Created new user as instance owner: jdoe@example.org (John Doe) via SSO`

## 6. If you still see the registration page

Check the n8n logs for:
- Any errors in the SSO middleware
- Whether the `Remote-Email` header is being received
- Whether the hook is even being triggered

Debug command:
```bash
docker compose logs n8n | grep -i "sso\|remote-email\|instance owner"
```
