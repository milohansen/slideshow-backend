# Firestore Authentication Setup

## The Issue
You're getting a Firestore connection error because your `client_secret.json` is an OAuth client configuration, not a service account key needed for server-to-server authentication with Firestore.

## Solutions

### Option 1: Use Service Account Key (Recommended for local development)

1. **Create a service account:**
   ```bash
   gcloud iam service-accounts create slideshow-backend \
     --description="Service account for slideshow backend" \
     --display-name="Slideshow Backend"
   ```

2. **Grant necessary permissions:**
   ```bash
   gcloud projects add-iam-policy-binding crafty-router-207406 \
     --member="serviceAccount:slideshow-backend@crafty-router-207406.iam.gserviceaccount.com" \
     --role="roles/datastore.user"
   
   gcloud projects add-iam-policy-binding crafty-router-207406 \
     --member="serviceAccount:slideshow-backend@crafty-router-207406.iam.gserviceaccount.com" \
     --role="roles/storage.admin"
   ```

3. **Create and download the key:**
   ```bash
   gcloud iam service-accounts keys create ./service-account-key.json \
     --iam-account=slideshow-backend@crafty-router-207406.iam.gserviceaccount.com
   ```

4. **Update your .env file:**
   ```
   GOOGLE_APPLICATION_CREDENTIALS="./service-account-key.json"
   ```

### Option 2: Use Application Default Credentials (ADC)

1. **Login with gcloud:**
   ```bash
   gcloud auth application-default login
   ```

2. **Update your .env to remove GOOGLE_APPLICATION_CREDENTIALS:**
   ```
   # Comment out or remove this line
   # GOOGLE_APPLICATION_CREDENTIALS="./client_secret.json"
   ```

### Option 3: Use Emulator for Development

1. **Start Firestore emulator:**
   ```bash
   gcloud emulators firestore start --host-port=localhost:8080
   ```

2. **Set environment variable:**
   ```
   FIRESTORE_EMULATOR_HOST="localhost:8080"
   ```

## Testing the Fix

After setting up authentication, restart your application:
```bash
deno task dev
```

The connection test in the updated Firestore initialization will verify the connection works.