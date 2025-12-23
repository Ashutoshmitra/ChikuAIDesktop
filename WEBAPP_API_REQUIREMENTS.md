# Required Webapp API Endpoints for Desktop Integration

The desktop app now uses the webapp backend instead of direct API calls. Here are the API endpoints that need to be available:

## ✅ **Already Exist in Webapp:**
- `GET /api/assemblyai-token` - Get AssemblyAI streaming token
- `POST /api/chat` - Generate AI responses with OpenAI
- `POST /api/analyze-screen` - Analyze screen content with OpenAI Vision

## 🆕 **New API Endpoints Needed:**

### 1. **Session Management**

#### **Create Session**
```
POST /api/sessions/create
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "sessionId": "uuid-generated-by-desktop",
  "company": "Company Name",
  "position": "Position Title", 
  "sessionType": "free" | "paid"
}

Response:
{
  "success": true,
  "sessionId": "uuid"
}
```

#### **Update Session**
```
POST /api/sessions/update
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "sessionId": "uuid",
  "minutesUsed": 10,
  "endedAt": "2024-01-01T00:00:00Z",
  "status": "completed"
}

Response:
{
  "success": true
}
```

#### **Save Transcript**
```
POST /api/sessions/transcript
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "sessionId": "uuid",
  "transcript": "Full transcript text..."
}

Response:
{
  "success": true
}
```

### 2. **Authentication Enhancement**

The existing auth callback needs to include a JWT token in the user data:

```javascript
// In your webapp's auth success redirect:
const userData = {
  id: user.id,
  email: user.email,
  name: user.name,
  image: user.image,
  token: jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' })
};

const redirectUrl = `chiku-ai-desktop://auth/success?user=${encodeURIComponent(JSON.stringify(userData))}`;
```

## 🔐 **Authentication Middleware**

All new endpoints should use JWT authentication middleware:

```javascript
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.sendStatus(401);
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};
```

## 📝 **Implementation Notes**

1. **Session Creation**: Use the same InterviewSession model from your existing webapp
2. **User Updates**: Update remainingMinutes and totalMinutesUsed in the User model
3. **Error Handling**: Return consistent error format: `{ success: false, error: "message" }`
4. **CORS**: Ensure CORS allows requests from desktop app (User-Agent: 'ChikuAI-Desktop/1.0')

## 🧪 **Testing Checklist**

- [ ] JWT token generation in auth callback
- [ ] Session creation API with authentication
- [ ] Session update API with minute tracking
- [ ] Transcript save API
- [ ] Error handling for invalid tokens
- [ ] CORS configuration for desktop requests

## 🚀 **Migration Benefits**

- **Security**: API keys stay on your secure backend
- **Flexibility**: Update/rotate keys anytime without desktop app updates
- **Cost Control**: Track and limit usage per user
- **Consistency**: Same business logic as webapp
- **Maintenance**: Single codebase for API logic