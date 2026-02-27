# Send to Kindle

A simple web application to extract articles from any URL, format them as EPUB, and send them to your Kindle via email.

## Features
- **Article Extraction:** Clean extraction of content using Mozilla's Readability.
- **EPUB Generation:** High-quality ebook formatting.
- **SMTP Delivery:** Send directly to your Kindle's "Send to Kindle" email address.

## Prerequisites
1.  **Kindle Email:** Find your "Send to Kindle" email in your Amazon account (Manage Your Content and Devices > Preferences > Personal Document Settings).
2.  **Authorized Sender:** Add your sender email (e.g., your Gmail) to the "Approved Personal Document E-mail List" in the same Amazon settings page.
3.  **App Password:** If using Gmail, you'll need an [App Password](https://myaccount.google.com/apppasswords).

## Running the Application

### 1. Start the Backend
```bash
cd backend
npm run dev # or: npx ts-node-dev index.ts
```

### 2. Start the Frontend
```bash
cd frontend
npm run dev
```

Open `http://localhost:5173` to use the tool.
