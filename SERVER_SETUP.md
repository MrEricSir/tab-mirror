# PeerJS Server Setup Guide

Tab Mirror uses PeerJS for peer-to-peer connections between browser instances. This guide covers both local testing and production deployment.

## Quick Start - Local Testing

For development and automated testing, use the included local PeerJS server.

### Start Local Server

```bash
npm run server:test
```

The server runs on `http://localhost:9000/myapp` and is automatically used by test builds.

### Build Test Version

```bash
npm run build:test
```

Test builds connect to the local PeerJS server and use random hex IDs for peer discovery.

### Run Tests

```bash
npm test                 # All tests with local server
npm run test:basic       # Basic sync tests
npm run test:multi       # Multi-instance tests
```

See `tests/README.md` for comprehensive testing documentation.

## Production Deployment

### Current Default: 0.peerjs.com

The extension currently uses the public `0.peerjs.com` server for production builds. This has **known reliability issues** and is not recommended for serious use.

### Recommended: Self-Hosted Server

For production use, deploy your own PeerJS server on a free hosting platform:

#### Option 1: Fly.io (Recommended)

**Pros**: Static IPs, excellent WebSocket support, multi-region, no suspension
**Free Tier**: 3 VMs with 256 MB RAM, 160 GB bandwidth/month

**Deployment**:
```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Create Dockerfile
cat > Dockerfile << 'EOF'
FROM node:18-alpine
RUN npm install -g peer
EXPOSE 9000
CMD ["peerjs", "--port", "9000", "--key", "peerjs", "--path", "/myapp"]
EOF

# Deploy
fly auth login
fly launch  # Follow prompts to create app
fly deploy  # Deploy server
```

Your server will be available at `https://your-app.fly.dev/myapp`

#### Option 2: Railway

**Pros**: Simple dashboard, auto-SSL, GitHub integration
**Free Tier**: $5 credit/month (enough for basic PeerJS server)

1. Go to [railway.app](https://railway.app)
2. Create new project → Deploy from Docker
3. Use the same Dockerfile as Fly.io
4. Railway provides HTTPS URL automatically

#### Option 3: Render

**Pros**: Easy setup, generous free tier
**Free Tier**: 750 hours/month (enough for 24/7 operation)

1. Go to [render.com](https://render.com)
2. New → Web Service → Docker
3. Use the Dockerfile above
4. Render provides HTTPS URL automatically

### Update Extension Configuration

After deploying your server, update the `PEER_CONFIG` object in `src/background.js`:

```javascript
const PEER_CONFIG = TEST_MODE
    ? { host: 'localhost', port: 9000, path: '/myapp', secure: false }
    : { host: '0.peerjs.com', port: 443, secure: true };
```

Replace the production host with your deployed server:

```javascript
const PEER_CONFIG = TEST_MODE
    ? { host: 'localhost', port: 9000, path: '/myapp', secure: false }
    : { host: 'your-app.fly.dev', port: 443, path: '/myapp', secure: true };
```

Then rebuild:
```bash
npm run build:prod
```

## Server Configuration

### Test Mode vs Production Mode

**Test Mode** (`npm run build:test`):
- Uses `localhost:9000` for the local PeerJS server
- Enables TestBridge API for automated testing
- Uses random hex IDs; peers discover each other via `listAllPeers()`

**Production Mode** (`npm run build:prod`):
- Uses configured production server (default: `0.peerjs.com`)
- No TestBridge API
- Device discovery via pairing codes
- Connections authenticated with HMAC-SHA256 and encrypted with AES-256-GCM

### Configuration Location

Server configuration is the `PEER_CONFIG` object in `src/background.js`:

```javascript
const PEER_CONFIG = TEST_MODE
    ? { host: 'localhost', port: 9000, path: '/myapp', secure: false }
    : { host: '0.peerjs.com', port: 443, secure: true };
```

## Testing Connection

### Manual Test

1. Build test version: `npm run build:test`
2. Load extension in two Firefox instances
3. Open Browser Console (F12) in both
4. Look for: `[P2P] Registered successfully: a3f7c1`
5. Wait 30s for connection: `[P2P] SUCCESS! Linked to b9e2d4`

### Automated Tests

```bash
npm test  # Runs all integration tests with local server
```

See `tests/README.md` for details on the test suite.

## Troubleshooting

### Server Won't Start
```bash
# Check if port 9000 is already in use
lsof -ti:9000 | xargs kill -9

# Try starting again
npm run server:test
```

### Extension Won't Connect
- Verify server is running: `curl http://localhost:9000/myapp`
- Check browser console for connection errors
- Ensure TEST_MODE build is being used
- Try reloading the extension

### Production Server Issues
- Verify HTTPS is enabled (WebRTC requires HTTPS)
- Check server logs for errors
- Test server directly: `curl https://your-server.com/myapp`
- Verify firewall allows WebSocket connections

## Next Steps

- **Development**: Use local server with `npm run server:test`
- **Testing**: Run `npm test` to validate functionality
- **Production**: Deploy your own server and update configuration
- **Documentation**: See `README.md` for user-facing setup instructions
