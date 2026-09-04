# AI Revenue Recovery

AI-powered revenue recovery platform that detects risky transactions, analyzes recovery opportunities with Gemini AI, validates recovery actions against business policies, executes recovery through Razorpay, and updates the recovery status through payment webhooks.

## Workflow

Transactions
→ Risk Detection
→ Recovery Cases
→ Gemini AI Analysis
→ Policy Validation
→ Recovery Action
→ Razorpay Payment
→ Webhook
→ RECOVERED
→ Dashboard Update

## Key Features

- Revenue risk detection for failed payments and checkout abandonment
- AI-powered recovery recommendations using Google Gemini
- Deterministic policy validation before recovery execution
- Razorpay payment-link based recovery
- Real Razorpay webhook handling with signature verification
- Recovery case lifecycle and audit timeline
- Dashboard for revenue at risk, recovered revenue, and recovery rate

## Tech Stack

- Frontend: React + Vite
- Backend: Node.js + Express
- Database: MongoDB Atlas + Mongoose
- AI: Google Gemini
- Payments: Razorpay
- Authentication: JWT + bcrypt

## Project Structure

```text
frontend/   # React/Vite dashboard
backend/    # Express API, AI, recovery, payments and webhooks