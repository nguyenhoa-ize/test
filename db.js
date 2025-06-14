const { Pool } = require('pg')
require('dotenv').config()

// Khởi tạo connection pool
const pool = new Pool({
  user: process.env.DB_USER,             // Tên người dùng Supabase
  host: process.env.DB_HOST,             // Host Supabase (.supabase.com)
  database: process.env.DB_NAME,         // Tên database
  password: process.env.DB_PASSWORD,     // Mật khẩu
  port: parseInt(process.env.DB_PORT || '5432', 10),
  ssl: {
    rejectUnauthorized: false            // Chỉ dùng khi môi trường không có CA hợp lệ
  },
  max: 15, // Giới hạn dưới mức tối đa của Supabase
  idleTimeoutMillis: 30000, // 30s không hoạt động sẽ đóng kết nối
  connectionTimeoutMillis: 5000, // Timeout kết nối sau 5s
  allowExitOnIdle: false // Ngăn process tự động exit khi idle
})

// Xử lý sự kiện lỗi
pool.on('error', (err) => {
  console.error('Unexpected database error:', err)
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
    // Tái khởi tạo pool nếu cần
    pool.end()
    process.exit(1)
  }
})

// Health check định kỳ
const healthCheckInterval = setInterval(async () => {
  try {
    await pool.query('SELECT NOW()', []); // Đảm bảo truyền mảng rỗng
  } catch (err) {
    console.error('Database health check failed:', err)
  }
}, 60000) // 1 phút

// Graceful shutdown
process.on('SIGINT', async () => {
  clearInterval(healthCheckInterval)
  await pool.end()
  process.exit(0)
})

// Utility functions
const getClient = async () => {
  const client = await pool.connect()
  
  // Proxy client để tự động release
  return new Proxy(client, {
    get: (target, prop) => {
      if (prop === 'release') {
        return () => {
          target.release()
          if (process.env.NODE_ENV !== 'production') {
            console.log('Client released back to pool')
          }
        }
      }
      return target[prop]
    }
  })
}

const query = async (text, params = []) => {
  const start = Date.now()
  try {
    const res = await pool.query(text, Array.isArray(params) ? params : [])
    const duration = Date.now() - start
    if (process.env.NODE_ENV !== 'production') {
      console.log('Executed query:', {
        text,
        duration,
        rows: res?.rowCount ?? 0
      })
    }
    return res
  } catch (err) {
    console.error('Query error:', { text, params })
    throw err
  }
}

// Transaction handler
const transaction = async (callback) => {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

module.exports = {
  pool,
  query,
  getClient,
  transaction,
  // Cho phép clean up trong test
  _pool: pool,
  clearHealthCheck: () => clearInterval(healthCheckInterval)
}
