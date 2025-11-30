# Database Setup Guide

Your API needs a PostgreSQL database to work. Currently, **your database is not connected** because the `DATABASE_URL` environment variable is not set.

## Quick Setup Options

### Option 1: Neon (Recommended - Free PostgreSQL)

1. **Sign up at [neon.tech](https://neon.tech)** (free tier available)

2. **Create a new project:**
   - Click "Create Project"
   - Choose a name (e.g., "des-lab")
   - Select a region close to you
   - Click "Create Project"

3. **Get your connection string:**
   - In your Neon dashboard, go to your project
   - Click "Connection Details"
   - Copy the **Connection String** (looks like: `postgresql://user:password@host/database?sslmode=require`)

4. **Set up locally:**
   - Create a `.env` file in your project root (this file is gitignored)
   - Add:
     ```bash
     DATABASE_URL=postgresql://user:password@host/database?sslmode=require
     ```
   - Replace with your actual Neon connection string

5. **Test the connection:**
   ```bash
   npm run api
   ```
   - You should see: `DES Lab API running on http://localhost:4000`
   - No database errors means it's connected!

---

### Option 2: Railway PostgreSQL

1. **Sign up at [railway.app](https://railway.app)**

2. **Create a new project:**
   - Click "New Project"
   - Select "Provision PostgreSQL"
   - Railway will create a database

3. **Get connection string:**
   - Click on your PostgreSQL service
   - Go to "Variables" tab
   - Copy the `DATABASE_URL` value

4. **Set up locally:**
   - Add to your `.env` file:
     ```bash
     DATABASE_URL=<railway-connection-string>
     ```

---

### Option 3: Supabase (Free PostgreSQL)

1. **Sign up at [supabase.com](https://supabase.com)**

2. **Create a new project:**
   - Click "New Project"
   - Fill in project details
   - Wait for database to provision

3. **Get connection string:**
   - Go to Project Settings → Database
   - Find "Connection string" → "URI"
   - Copy the connection string

4. **Set up locally:**
   - Add to your `.env` file:
     ```bash
     DATABASE_URL=<supabase-connection-string>
     ```

---

## Local Setup Steps

### 1. Create `.env` file

In your project root (`/Users/omarobeid/Desktop/455/`), create a `.env` file:

```bash
# Database connection
DATABASE_URL=postgresql://user:password@host:port/database?sslmode=require

# JWT Secret (generate a random string)
# You can use: openssl rand -base64 32
JWT_SECRET=your-super-secret-jwt-key-here

# CORS origins (for local development)
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000

# Optional: Seed a default teacher account
SEED_TEACHER_EMAIL=admin@example.com
SEED_TEACHER_PASSWORD=secure-password-here
```

### 2. Test the connection

```bash
# Start your API server
npm run api
```

You should see:
- ✅ `DES Lab API running on http://localhost:4000`
- ✅ No database connection errors
- ✅ Tables will be created automatically on first run

### 3. Verify it's working

Test the health endpoint:
```bash
curl http://localhost:4000/health
```

Should return: `{"ok":true,"service":"des-lab-api"}`

---

## For Vercel Deployment

When you deploy to Vercel, you need to set the same environment variables:

1. **Go to your Vercel project dashboard**
2. **Settings → Environment Variables**
3. **Add:**
   ```
   DATABASE_URL=<your-database-connection-string>
   JWT_SECRET=<your-jwt-secret>
   ALLOWED_ORIGINS=https://your-app.vercel.app,http://localhost:5173
   ```
4. **Redeploy** your project

---

## Troubleshooting

### "DATABASE_URL is not set" warning

- ✅ Create a `.env` file in your project root
- ✅ Add `DATABASE_URL=your-connection-string`
- ✅ Make sure `.env` is in `.gitignore` (don't commit it!)

### Connection refused errors

- Check your database connection string is correct
- For Neon: Make sure "Allow connections from any IP" is enabled
- For Railway: Use the connection string from the Variables tab
- Test the connection string directly with `psql` or a database client

### SSL errors

- Add `?sslmode=require` to your connection string
- Or use `?sslmode=prefer` if your database supports it

### Tables not created

- The tables are created automatically on first API request
- Check your database permissions
- Make sure the user has CREATE TABLE permissions

---

## Recommended: Neon

**Why Neon?**
- ✅ Free tier (512 MB storage, 0.5 CPU)
- ✅ Serverless PostgreSQL
- ✅ Easy to set up
- ✅ Great for development and small projects
- ✅ Auto-scales
- ✅ Built-in connection pooling

**Get started:** [neon.tech](https://neon.tech) → Sign up → Create project → Copy connection string

---

## Next Steps

1. ✅ Choose a database provider (Neon recommended)
2. ✅ Get your connection string
3. ✅ Create `.env` file with `DATABASE_URL`
4. ✅ Test locally: `npm run api`
5. ✅ Set environment variables in Vercel for deployment

Your database will be connected! 🎉

