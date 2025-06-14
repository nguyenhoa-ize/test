const sanitizeInput = (input) => {
  if (typeof input !== 'string') return '';
  // Xóa các ký tự
  return input.replace(/[<>;{}]/g, '');
};

module.exports = { sanitizeInput };