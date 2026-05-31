module.exports = {
  PORT: process.env.PORT || 3000,
  AUTH: {
    USERNAME: 'admin',
    PASSWORD: 'admin123'   // ← غيّر كلمة المرور قبل النشر
  },
  DB_PATH: './data/db.sqlite',
  SESSION_KEEP_MINUTES: 15   // مدة الاحتفاظ ببيانات الزائر بعد مغادرته
};
