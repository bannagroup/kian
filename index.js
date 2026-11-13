require('dotenv').config();
const express = require('express');
const { neon } = require('@neondatabase/serverless');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

const sql = neon(process.env.DATABASE_URL);

app.get('/api/health', async (req, res) => {
  try {
    const result = await sql`SELECT version()`;
    res.json({ 
      status: 'success', 
      message: 'السيرفر شغال و Neon متصل!',
      dbVersion: result[0].version 
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ السيرفر شغال على http://localhost:${PORT}`);
});
