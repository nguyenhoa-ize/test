const express = require("express");
const router = express.Router();
const multer = require("multer");
const { isAuthenticated } = require("../middlewares/auth.middleware");
const cloudinary = require("cloudinary").v2;
const winston = require("winston"); // Thêm thư viện logging

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure logging
const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: "error.log", level: "error" }),
        new winston.transports.File({ filename: "combined.log" }),
    ],
});

if (process.env.NODE_ENV !== "production") {
    logger.add(
        new winston.transports.Console({
            format: winston.format.simple(),
        })
    );
}

// Configure multer to use memory storage
const storage = multer.memoryStorage();

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("image/")) {
            cb(null, true);
        } else {
            cb(new Error("Chỉ hỗ trợ file ảnh (jpg, png, ...)"));
        }
    },
});

// Error handling middleware for multer
const handleMulterError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        logger.error("Multer error", { code: err.code, message: err.message });
        if (err.code === "LIMIT_FILE_SIZE")
            return res.status(413).json({ error: "File quá lớn, tối đa 5MB" });
        return res.status(400).json({ error: err.message });
    }
    next(err);
};

router.post(
    "/",
    isAuthenticated,
    upload.single("image"),
    handleMulterError,
    async (req, res, next) => {
        try {
            if (!req.file) {
                logger.warn("No file uploaded");
                return res
                    .status(400)
                    .json({ error: "Vui lòng chọn một file ảnh" });
            }

            logger.info("Uploading file to Cloudinary from buffer", {
                fileName: req.file.originalname,
                size: req.file.size,
            });

            const result = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    {
                        folder: "solace_uploads",
                        resource_type: "image",
                    },
                    (error, result) => {
                        if (error) {
                            return reject(error);
                        }
                        resolve(result);
                    }
                );
                stream.end(req.file.buffer);
            });

            logger.info("File uploaded successfully", {
                url: result.secure_url,
            });
            res.json({ url: result.secure_url });
        } catch (error) {
            logger.error("Upload failed", {
                error: error.message,
                stack: error.stack,
            });
            res.status(500).json({
                error: "Lỗi khi upload ảnh, vui lòng thử lại",
            });
        }
    }
);

module.exports = router;
