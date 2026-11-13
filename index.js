require('dotenv').config();
const express = require('express');
const { neon } = require('@neondatabase/serverless');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// خدمة ملفات الواجهة (Frontend)
app.use(express.static(path.join(__dirname, 'public')));

const sql = neon(process.env.DATABASE_URL);

// --- 1. فحص الاتصال (Health Check) ---
app.get('/api/health', async (req, res) => {
  try {
    const result = await sql`SELECT version()`;
    res.json({ status: 'success', message: 'السيرفر شغال و Neon متصل!', dbVersion: result[0].version });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// --- 2. جلب كل الموظفين ---
app.get('/api/employees', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM employees ORDER BY code ASC`;
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 3. إضافة أو تعديل موظف ---
app.post('/api/employees', async (req, res) => {
  const { code, name, dept } = req.body;
  try {
    const result = await sql`
      INSERT INTO employees (code, name, dept) 
      VALUES (${code}, ${name}, ${dept}) 
      ON CONFLICT (code) DO UPDATE SET name = ${name}, dept = ${dept}
      RETURNING *`;
    res.json({ success: true, data: result[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 4. حذف موظف ---
app.delete('/api/employees/:code', async (req, res) => {
  try {
    await sql`DELETE FROM employees WHERE code = ${req.params.code}`;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ السيرفر شغال على http://localhost:${PORT}`);
});
