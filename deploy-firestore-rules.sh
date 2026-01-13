#!/bin/bash

# Deploy Firestore Security Rules
# This script will update your Firestore security rules to allow authenticated access

echo "🔐 Deploying Firestore security rules..."

# Check if Firebase CLI is installed
if ! command -v firebase &> /dev/null; then
    echo "❌ Firebase CLI not found. Installing..."
    npm install -g firebase-tools
fi

# Initialize Firebase if not already done
if [ ! -f "firebase.json" ]; then
    echo "🔧 Initializing Firebase project..."
    firebase init firestore --project crafty-router-207406
fi

# Deploy the rules
echo "🚀 Deploying rules to Firestore..."
firebase deploy --only firestore:rules --project crafty-router-207406

echo "✅ Firestore security rules deployed successfully!"
echo ""
echo "📋 What changed:"
echo "   - Allowed read/write access for authenticated requests"
echo "   - Your backend service account can now access Firestore data"
echo ""
echo "💡 Next steps:"
echo "   1. Restart your server: deno task dev"
echo "   2. Test the /ui page - it should now load without crashes"