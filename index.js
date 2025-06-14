const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require('path');
const http = require('http');

const userRoutes = require("./routes/user.routes");
const authRoutes = require("./routes/auth.routes");
const postRoutes = require("./routes/posts"); 
const searchRoutes = require("./routes/search");
const reportRoutes = require("./routes/reports");
const forbiddenWordsRoutes = require("./routes/forbidden_words");
const adminPostRoutes = require("./routes/post.routes");  
const commentsRouter = require('./routes/comments');
const likesRouter = require('./routes/likes');
const dashboardRoutes = require('./routes/dashboard.routes');
const visitsRoutes = require('./routes/visits.routes'); 
const messagesRoutes = require('./routes/messages.routes');
const pool = require("./db");

dotenv.config();

const app = express();

// CORS cấu hình rõ ràng
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ],
  credentials: true
}));

app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET));

// Kiểm tra JWT_SECRET
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("LỖI: JWT_SECRET chưa được định nghĩa trong file .env. Vui lòng kiểm tra lại.");
  process.exit(1);
}

// Kiểm tra kết nối PostgreSQL
pool.query("SELECT NOW()", (err, res) => {
  if (err) {
    console.error("Kết nối PostgreSQL thất bại:", err.message);
  } else {
    console.log("Kết nối PostgreSQL thành công:", res.rows[0]);
  }
});

// Route test
app.get("/", (req, res) => {
  res.send("Solace API");
});

// Gắn các route
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/posts", postRoutes);
app.use("/api", searchRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/admin/posts", adminPostRoutes); 
app.use('/api/comments', commentsRouter);
app.use('/api/likes', likesRouter);
app.use("/api/forbidden_words", forbiddenWordsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/visits', visitsRoutes);
app.use('/api/messages', messagesRoutes);


// Khởi tạo HTTP server
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

// Khởi tạo socket.io qua module riêng
const socketModule = require('./socket');
socketModule.init(server);

// Khởi động server
server.listen(PORT, () => console.log(`Server chạy trên http://localhost:${PORT}`));