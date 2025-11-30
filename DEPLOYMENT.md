# API Deployment Guide

This guide covers deploying your DES Lab API to production hosting services.

## Prerequisites

- A PostgreSQL database (Neon, Railway, or Supabase)
- Environment variables configured
- Git repository (GitHub recommended)

## Option 1: Railway (Recommended - Easiest)

### Steps:

1. **Sign up at [railway.app](https://railway.app)**

2. **Create a new project:**
   - Click "New Project"
   - Select "Deploy from GitHub repo" (connect your repo)
   - OR select "Empty Project" and connect later

3. **Add PostgreSQL database:**
   - In your project, click "+ New"
   - Select "Database" → "PostgreSQL"
   - Railway will create a database and provide a `DATABASE_URL`

4. **Deploy your API:**
   - Click "+ New" → "GitHub Repo" (if not already connected)
   - Select your repository
   - Railway will auto-detect Node.js

5. **Set Environment Variables:**
   - Go to your service → "Variables" tab
   - Add these variables:
     ```
     DATABASE_URL=<your-postgres-connection-string>
     JWT_SECRET=<generate-a-random-secret-string>
     PORT=4000
     ALLOWED_ORIGINS=https://your-frontend-domain.vercel.app,http://localhost:5173
     SEED_TEACHER_EMAIL=your-email@example.com (optional)
     SEED_TEACHER_PASSWORD=your-password (optional)
     ```

6. **Deploy:**
   - Railway will automatically build and deploy
   - Your API will be available at: `https://your-app-name.up.railway.app`

7. **Update Frontend:**
   - In your Vercel project, add environment variable:
     ```
     VITE_API_URL=https://your-app-name.up.railway.app
     ```

---

## Option 2: Render

### Steps:

1. **Sign up at [render.com](https://render.com)**

2. **Create a Web Service:**
   - Click "New" → "Web Service"
   - Connect your GitHub repository
   - Settings:
     - **Name:** `des-lab-api`
     - **Environment:** `Node`
     - **Build Command:** `npm install`
     - **Start Command:** `node server/index.js`
     - **Plan:** Free tier available

3. **Add PostgreSQL:**
   - Click "New" → "PostgreSQL"
   - Create database (free tier available)
   - Copy the "Internal Database URL"

4. **Set Environment Variables:**
   - In your Web Service → "Environment" tab:
     ```
     DATABASE_URL=<postgres-connection-string>
     JWT_SECRET=<random-secret>
     PORT=4000
     ALLOWED_ORIGINS=https://your-frontend.vercel.app
     ```

5. **Deploy:**
   - Render will build and deploy automatically
   - Your API URL: `https://des-lab-api.onrender.com`

---

## Option 3: Fly.io

### Steps:

1. **Install Fly CLI:**
   ```bash
   curl -L https://fly.io/install.sh | sh
   ```

2. **Login:**
   ```bash
   fly auth login
   ```

3. **Create `fly.toml`:**
   ```toml
   app = "des-lab-api"
   primary_region = "iad"

   [build]

   [env]
     PORT = "4000"

   [[services]]
     internal_port = 4000
     protocol = "tcp"

     [[services.ports]]
       port = 80
       handlers = ["http"]
       force_https = true

     [[services.ports]]
       port = 443
       handlers = ["tls", "http"]
   ```

4. **Deploy:**
   ```bash
   fly launch
   fly secrets set DATABASE_URL="your-connection-string"
   fly secrets set JWT_SECRET="your-secret"
   fly secrets set ALLOWED_ORIGINS="https://your-frontend.vercel.app"
   ```

---

## Option 4: Vercel Serverless Functions

If you want everything on Vercel, you'll need to convert your Express routes to serverless functions. This requires more refactoring but keeps everything in one place.

### Steps:

1. **Create `api/` directory structure:**
   ```
   api/
     login.ts
     signup.ts
     roster.ts
     grades.ts
     runs.ts
   ```

2. **Convert each Express route to a Vercel serverless function**

3. **Deploy to Vercel** (same project as frontend)

---

## Environment Variables Summary

Required for all hosting options:

```bash
DATABASE_URL=postgresql://user:password@host:port/database
JWT_SECRET=your-super-secret-jwt-key-here
ALLOWED_ORIGINS=https://your-frontend.vercel.app,http://localhost:5173
```

Optional:
```bash
SEED_TEACHER_EMAIL=admin@example.com
SEED_TEACHER_PASSWORD=secure-password
PORT=4000
```

---

## Testing Your Deployment

1. **Health check:**
   ```bash
   curl https://your-api-url.com/health
   ```

2. **Test signup:**
   ```bash
   curl -X POST https://your-api-url.com/api/signup \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"test123","name":"Test User"}'
   ```

3. **Update frontend `.env` or Vercel environment variables:**
   ```
   VITE_API_URL=https://your-api-url.com
   ```

---

## Recommended: Railway

Railway is recommended because:
- ✅ Free tier with $5 credit/month
- ✅ Easy PostgreSQL integration
- ✅ Automatic HTTPS
- ✅ Simple environment variable management
- ✅ GitHub integration
- ✅ Good for Express.js apps

---

## Troubleshooting

**CORS errors:**
- Make sure `ALLOWED_ORIGINS` includes your frontend URL
- Check that your frontend is using the correct API URL

**Database connection errors:**
- Verify `DATABASE_URL` is correct
- Check if your database allows connections from the hosting IP
- For Neon, ensure "Allow connections from any IP" is enabled

**Port errors:**
- Most platforms set `PORT` automatically
- Don't hardcode port 4000 in production

