# Deploying to Vercel

Your Express API can be deployed to Vercel as serverless functions. This guide walks you through the setup.

## Prerequisites

- Vercel account ([vercel.com](https://vercel.com))
- GitHub repository (recommended)
- PostgreSQL database (Neon, Railway, or Supabase)

## Quick Deploy Steps

### 1. Connect Your Repository

1. Go to [vercel.com](https://vercel.com) and sign in
2. Click "Add New..." → "Project"
3. Import your GitHub repository
4. Vercel will auto-detect your project

### 2. Configure Build Settings

Vercel should auto-detect, but verify these settings:

- **Framework Preset:** Vite
- **Build Command:** `npm run build`
- **Output Directory:** `dist`
- **Install Command:** `npm install`

### 3. Set Environment Variables

In your Vercel project dashboard, go to **Settings** → **Environment Variables** and add:

```bash
# Database connection (from Neon, Railway, or Supabase)
DATABASE_URL=postgresql://user:password@host:port/database

# JWT Secret (generate a random string)
# Use: openssl rand -base64 32
JWT_SECRET=your-super-secret-jwt-key-here

# CORS - Include your Vercel frontend URL
ALLOWED_ORIGINS=https://your-app.vercel.app,http://localhost:5173

# Optional: Seed default teacher
SEED_TEACHER_EMAIL=admin@example.com
SEED_TEACHER_PASSWORD=secure-password
```

**Important:** 
- Add these for **Production**, **Preview**, and **Development** environments
- After adding variables, you'll need to redeploy

### 4. Deploy

1. Click **Deploy** (or push to your main branch)
2. Vercel will build and deploy your app
3. Your API will be available at: `https://your-project.vercel.app/api/*`

### 5. Update Frontend API URL

In your Vercel project (or local `.env`), set:

```bash
VITE_API_URL=https://your-project.vercel.app
```

## How It Works

- **Frontend:** Served from `dist/` directory (Vite build)
- **API Routes:** All `/api/*` and `/health` requests are routed to `api/index.js` (serverless function)
- **Other Routes:** All other routes serve your React app (`index.html`)

## Testing Your Deployment

1. **Health Check:**
   ```bash
   curl https://your-project.vercel.app/health
   ```
   Should return: `{"ok":true,"service":"des-lab-api"}`

2. **Test Signup:**
   ```bash
   curl -X POST https://your-project.vercel.app/api/signup \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"test123","name":"Test User"}'
   ```

3. **Test Login:**
   ```bash
   curl -X POST https://your-project.vercel.app/api/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"test123"}'
   ```

## API Endpoints

Your API will be available at:
- `https://your-project.vercel.app/api/login`
- `https://your-project.vercel.app/api/signup`
- `https://your-project.vercel.app/api/roster`
- `https://your-project.vercel.app/api/grades`
- `https://your-project.vercel.app/api/runs`
- `https://your-project.vercel.app/health`

## Troubleshooting

### CORS Errors

- Make sure `ALLOWED_ORIGINS` includes your frontend URL
- Check that your frontend is using the correct API URL
- Vercel automatically handles CORS for serverless functions, but your Express CORS config should still work

### Database Connection Errors

- Verify `DATABASE_URL` is correct
- Check if your database allows connections from Vercel's IP ranges
- For Neon: Enable "Allow connections from any IP" in database settings
- Test connection locally first: `node server/index.js`

### Function Timeout

- Default timeout is 10 seconds
- We've set `maxDuration: 30` in `vercel.json` for longer operations
- If you need more, upgrade to Vercel Pro (60s) or Enterprise (300s)

### Build Errors

- Make sure all dependencies are in `package.json`
- Check that `server/` and `api/` directories are included in your repo
- Verify Node.js version (Vercel uses Node 18.x by default)

## Local Development

You can still run the API locally:

```bash
npm run api
```

This starts the Express server on `http://localhost:4000`

## Vercel CLI (Optional)

You can also deploy using the Vercel CLI:

```bash
npm i -g vercel
vercel login
vercel
```

## Cost

- **Hobby Plan (Free):**
  - 100GB bandwidth/month
  - Serverless function execution time: 10s (free), 60s (Pro)
  - Perfect for development and small projects

- **Pro Plan ($20/month):**
  - More bandwidth
  - 60s function timeout
  - Better for production

## Advantages of Vercel

✅ **Same platform as frontend** - Everything in one place  
✅ **Automatic HTTPS** - SSL certificates included  
✅ **Global CDN** - Fast response times worldwide  
✅ **Zero config** - Works out of the box  
✅ **Git integration** - Auto-deploy on push  
✅ **Preview deployments** - Test before merging  

## Next Steps

1. Deploy to Vercel
2. Test all API endpoints
3. Update frontend `VITE_API_URL`
4. Test authentication flow
5. Monitor function logs in Vercel dashboard

Your API is now live! 🚀

