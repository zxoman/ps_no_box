const { contextBridge, ipcRenderer } = require('electron');

// نظام القفل lockall
contextBridge.exposeInMainWorld('ps4LockAPI', {
  getStatus: () => ipcRenderer.invoke('ps4lock-status-all'),
  testDevice: (deviceId) => ipcRenderer.invoke('ps4lock-test-device', deviceId),
  command: (deviceId, command) => ipcRenderer.invoke('ps4lock-command', { deviceId, command }),
  getSettings: () => ipcRenderer.invoke('get-ps4lock-settings'),
  setSettings: (settings) => ipcRenderer.invoke('set-ps4lock-settings', settings)
});

contextBridge.exposeInMainWorld('deviceAPI', {
  addDevice: (device) => ipcRenderer.invoke('add-device', device),
  updateDevice: (device) => ipcRenderer.invoke('update-device', device),
  getDevices: () => ipcRenderer.invoke('get-devices'),
  deleteDevice: (deviceId) => ipcRenderer.invoke('delete-device', deviceId),
  saveDeviceImage: (filePath) => ipcRenderer.invoke('save-device-image', filePath),
});

  contextBridge.exposeInMainWorld('sessionAPI', {
    startSession: (data) => ipcRenderer.invoke('start-session', data),
    startFreeSession: (data) => ipcRenderer.invoke('start-free-session', data),
    startFreeOpenSession: (data) => ipcRenderer.invoke('start-free-open-session', data),
    endSession: (device_id) => ipcRenderer.invoke('end-session', device_id),
    getActiveSession: (device_id) => ipcRenderer.invoke('get-active-session', device_id),
    getActiveSession1: (device_id) => ipcRenderer.invoke('get-active-session1', device_id),
    transferSession: (data) => ipcRenderer.invoke('transfer-session', data),
    addExtraTimeToSession: (data) => ipcRenderer.invoke('add-extra-time-to-session', data),
    getSessionModifications: (session_id) => ipcRenderer.invoke('get-session-modifications', session_id),
    updateSessionTypeOrMode: (data) => ipcRenderer.invoke('update-session-type-or-mode', data),
    deleteSession: (sessionId) => ipcRenderer.invoke('delete-session', sessionId),
    updateSession: (data) => ipcRenderer.invoke('update-session', data)
  });

contextBridge.exposeInMainWorld('sessionsAPI', {
  getAll: () => ipcRenderer.invoke('get-all-sessions'),
  getPage: (limit, offset) => ipcRenderer.invoke('get-sessions-page', { limit, offset }),
  getCount: () => ipcRenderer.invoke('get-sessions-count'),
  getProductsBatch: (sessionIds) => ipcRenderer.invoke('get-session-products-batch', sessionIds)
});

contextBridge.exposeInMainWorld('productsAPI', {
  addProduct: (product) => ipcRenderer.invoke('add-product', product),
  getProducts: () => ipcRenderer.invoke('get-products'),
  updateProduct: (product) => ipcRenderer.invoke('update-product', product),
  deleteProduct: (productId) => ipcRenderer.invoke('delete-product', productId),
  saveProductImage: (filePath) => ipcRenderer.invoke('save-product-image', filePath),
  getCustomerURL: () => ipcRenderer.invoke('get-customer-url'),
  getAllCustomerURLs: () => ipcRenderer.invoke('get-all-customer-urls')
});

contextBridge.exposeInMainWorld('customerOrdersAPI', {
  getCustomerOrders: () => ipcRenderer.invoke('get-customer-orders'),
  updateOrderStatus: (orderId, status) => ipcRenderer.invoke('update-customer-order-status', { orderId, status })
});

contextBridge.exposeInMainWorld('customerChatAPI', {
  getMessages: (device_id) => ipcRenderer.invoke('get-customer-messages', device_id),
  getAllMessages: () => ipcRenderer.invoke('get-all-customer-messages'),
  sendAdminMessage: (device_id, message) => ipcRenderer.invoke('send-admin-message', { device_id, message }),
  markAsRead: (device_id) => ipcRenderer.invoke('mark-messages-as-read', device_id),
  getLastMessageDevice: () => ipcRenderer.invoke('get-last-message-device')
});

contextBridge.exposeInMainWorld('componentsAPI', {
  addComponent: (component) => ipcRenderer.invoke('add-component', component),
  getComponents: () => ipcRenderer.invoke('get-components'),
  updateComponent: (component) => ipcRenderer.invoke('update-component', component),
  deleteComponent: (componentId) => ipcRenderer.invoke('delete-component', componentId),
  updateComponentInventory: (data) => ipcRenderer.invoke('update-component-inventory', data),
  getComponentInventory: (componentId) => ipcRenderer.invoke('get-component-inventory', componentId),
  addProductComponent: (data) => ipcRenderer.invoke('add-product-component', data),
  getProductComponents: (productId) => ipcRenderer.invoke('get-product-components', productId),
  updateProductComponent: (data) => ipcRenderer.invoke('update-product-component', data),
  deleteProductComponent: (id) => ipcRenderer.invoke('delete-product-component', id),
  checkProductComponentsAvailability: (data) => ipcRenderer.invoke('check-product-components-availability', data),
  cleanupDuplicateComponentInventory: () => ipcRenderer.invoke('cleanup-duplicate-component-inventory')
});

// Debts API
contextBridge.exposeInMainWorld('debtsAPI', {
  add: (debt) => ipcRenderer.invoke('debts-add', debt),
  getAll: () => ipcRenderer.invoke('debts-get-all'),
  update: (debt) => ipcRenderer.invoke('debts-update', debt),
  delete: (id) => ipcRenderer.invoke('debts-delete', id),
  markPaid: (id) => ipcRenderer.invoke('debts-mark-paid', id),
  payPartial: (data) => ipcRenderer.invoke('debts-pay-partial', data)
});

// Clients API
contextBridge.exposeInMainWorld('clientsAPI', {
  add: (client) => ipcRenderer.invoke('clients-add', client),
  getAll: () => ipcRenderer.invoke('clients-get-all'),
  update: (client) => ipcRenderer.invoke('clients-update', client),
  delete: (id) => ipcRenderer.invoke('clients-delete', id),
  addBalance: (data) => ipcRenderer.invoke('clients-add-balance', data),
  deductBalance: (data) => ipcRenderer.invoke('clients-deduct-balance', data),
  getBalance: (client_id) => ipcRenderer.invoke('clients-get-balance', client_id)
});

// Trust deposits (الأمانة)
contextBridge.exposeInMainWorld('trustDepositsAPI', {
  add: (data) => ipcRenderer.invoke('trust-add', data),
  getAll: () => ipcRenderer.invoke('trust-get-all'),
  delete: (id) => ipcRenderer.invoke('trust-delete', id)
});

// Bookings API
contextBridge.exposeInMainWorld('bookingsAPI', {
  add: (booking) => ipcRenderer.invoke('bookings-add', booking),
  getAll: () => ipcRenderer.invoke('bookings-get-all'),
  update: (booking) => ipcRenderer.invoke('bookings-update', booking),
  delete: (id) => ipcRenderer.invoke('bookings-delete', id),
  getUpcoming: () => ipcRenderer.invoke('bookings-get-upcoming')
});

contextBridge.exposeInMainWorld('productsSalesAPI', {
  addToSession: (data) => ipcRenderer.invoke('add-product-to-session', data),
  getSessionProducts: (session_id) => ipcRenderer.invoke('get-session-products', session_id),
  updateSessionProductQty: (sessionProductId, qty) => ipcRenderer.invoke('update-session-product-qty', { sessionProductId, qty }),
  deleteSessionProduct: (sessionProductId) => ipcRenderer.invoke('delete-session-product', sessionProductId)
});

contextBridge.exposeInMainWorld('invoicesAPI', {
  getSummary: () => ipcRenderer.invoke('get-invoices-summary'),
  getReportSummary: (filters) => ipcRenderer.invoke('get-report-summary', filters),
  getFilteredSessions: (filters) => ipcRenderer.invoke('get-filtered-sessions', filters),
  getFilteredStandaloneSales: (filters) => ipcRenderer.invoke('get-filtered-standalone-sales', filters)
});

contextBridge.exposeInMainWorld('standaloneSalesAPI', {
  add: (data) => ipcRenderer.invoke('add-standalone-sale', data),
  getAll: () => ipcRenderer.invoke('get-standalone-sales'),
  update: (saleId, updates) => ipcRenderer.invoke('update-standalone-sale', { saleId, updates }),
  delete: (saleId) => ipcRenderer.invoke('delete-standalone-sale', saleId)
});

// API للأذرع (Controllers)
contextBridge.exposeInMainWorld('controllersAPI', {
  add: (controller) => ipcRenderer.invoke('add-controller', controller),
  update: (controller) => ipcRenderer.invoke('update-controller', controller),
  delete: (id) => ipcRenderer.invoke('delete-controller', id),
  getAll: () => ipcRenderer.invoke('get-controllers')
});

contextBridge.exposeInMainWorld('expensesAPI', {
  addExpense: (expense) => ipcRenderer.invoke('add-expense', expense),
  updateExpense: (expense) => ipcRenderer.invoke('update-expense', expense),
  deleteExpense: (expenseId) => ipcRenderer.invoke('delete-expense', expenseId),
  getExpenses: () => ipcRenderer.invoke('get-expenses'),
  getExpensesByDateRange: (startDate, endDate) => ipcRenderer.invoke('get-expenses-by-date-range', { startDate, endDate }),
  getExpensesByCategory: (category) => ipcRenderer.invoke('get-expenses-by-category', category),
  getExpensesByShift: (shift_id) => ipcRenderer.invoke('get-expenses-by-shift', shift_id),
  getExpenseCategories: () => ipcRenderer.invoke('get-expense-categories'),
  getTotalExpenses: (startDate, endDate) => ipcRenderer.invoke('get-total-expenses', { startDate, endDate }),
  getTotalExpensesByFrequency: (frequency, startDate, endDate) => ipcRenderer.invoke('get-total-expenses-by-frequency', { frequency, startDate, endDate }),
  // دوال جديدة لحساب المصروفات في الشيفتات
  getShiftExpenses: (shift_id) => ipcRenderer.invoke('get-shift-expenses', shift_id),
  getAllShiftsExpenses: () => ipcRenderer.invoke('get-all-shifts-expenses'),
  getExpensesStatistics: (startDate, endDate) => ipcRenderer.invoke('get-expenses-statistics', { startDate, endDate })
});

contextBridge.exposeInMainWorld('maintenanceAPI', {
  addMaintenance: (maintenance) => ipcRenderer.invoke('add-maintenance', maintenance),
  updateMaintenance: (maintenance) => ipcRenderer.invoke('update-maintenance', maintenance),
  deleteMaintenance: (maintenanceId) => ipcRenderer.invoke('delete-maintenance', maintenanceId),
  getMaintenance: () => ipcRenderer.invoke('get-maintenance'),
  getMaintenanceByStatus: (status) => ipcRenderer.invoke('get-maintenance-by-status', status),
  getMaintenanceByDevice: (deviceId) => ipcRenderer.invoke('get-maintenance-by-device', deviceId),
  getMaintenanceByDateRange: (startDate, endDate) => ipcRenderer.invoke('get-maintenance-by-date-range', { startDate, endDate }),
  getMaintenanceStats: () => ipcRenderer.invoke('get-maintenance-stats'),
  getMaintenanceByType: (type) => ipcRenderer.invoke('get-maintenance-by-type', type)
});

contextBridge.exposeInMainWorld('usersAPI', {
  checkLogin: (username, password) => ipcRenderer.invoke('check-login', { username, password }),
  getUsers: () => ipcRenderer.invoke('get-users'),
  addUser: (user) => ipcRenderer.invoke('add-user', user),
  updateUser: (user) => ipcRenderer.invoke('update-user', user),
  deleteUser: (userId) => ipcRenderer.invoke('delete-user', userId),
  // صلاحيات المستخدمين
  getUserPermissions: (userId) => ipcRenderer.invoke('get-user-permissions', userId),
  setUserPermissions: (userId, permissions) => ipcRenderer.invoke('set-user-permissions', { userId, permissions }),
  checkUserPermission: (userId, page, action) => ipcRenderer.invoke('check-user-permission', { userId, page, action }),
  getAllPages: () => ipcRenderer.invoke('get-all-pages'),
  fixUserPermissions: () => ipcRenderer.invoke('fix-user-permissions')
});

contextBridge.exposeInMainWorld('backupAPI', {
  backupDatabase: () => ipcRenderer.invoke('backup-database'),
  restoreDatabase: () => ipcRenderer.invoke('restore-database')
});

contextBridge.exposeInMainWorld('tournamentsAPI', {
  saveTournament: (data) => ipcRenderer.invoke('save-tournament', data),
  getAll: () => ipcRenderer.invoke('get-all-tournaments'),
  getById: (id) => ipcRenderer.invoke('get-tournament-by-id', id),
  deleteTournament: (id) => ipcRenderer.invoke('delete-tournament', id),
  // لاعبين الدورات
  addPlayer: (data) => ipcRenderer.invoke('add-tournament-player', data),
  getPlayers: (tournament_id) => ipcRenderer.invoke('get-tournament-players', tournament_id),
  deletePlayer: (player_id) => ipcRenderer.invoke('delete-tournament-player', player_id),
  // مباريات الدورات
  addMatch: (data) => ipcRenderer.invoke('add-tournament-match', data),
  updateMatchResult: (data) => ipcRenderer.invoke('update-tournament-match-result', data),
  getMatches: (tournament_id) => ipcRenderer.invoke('get-tournament-matches', tournament_id),
  deleteMatch: (match_id) => ipcRenderer.invoke('delete-tournament-match', match_id)
});

contextBridge.exposeInMainWorld('electronAPI', {
  activateTrial: (code) => ipcRenderer.invoke('activate-trial', code),
  getHardwareSerial: () => ipcRenderer.invoke('get-hardware-serial'),
  getActivationRequestCode: () => ipcRenderer.invoke('get-activation-request-code'),
  getControllerMac: () => ipcRenderer.invoke('get-controller-mac'),
  recordKidsAreaSale: (data) => ipcRenderer.invoke('record-kids-area-sale', data),
  // دوال الشيفتات
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  startShift: (data) => ipcRenderer.invoke('start-shift', data),
  endShift: (data) => ipcRenderer.invoke('end-shift', data),
  getActiveShift: () => ipcRenderer.invoke('get-active-shift'),
  getAllShifts: () => ipcRenderer.invoke('get-all-shifts'),
  getShiftDetails: (shift_id) => ipcRenderer.invoke('get-shift-details', shift_id),
  updateShiftOpeningCash: (data) => ipcRenderer.invoke('update-shift-opening-cash', data)
});

contextBridge.exposeInMainWorld('shopSettingsAPI', {
  getShopSettings: () => ipcRenderer.invoke('get-shop-settings'),
  updateShopSettings: (data) => ipcRenderer.invoke('update-shop-settings', data),
});

contextBridge.exposeInMainWorld('offersAPI', {
  getOffers: () => ipcRenderer.invoke('get-offers'),
  createOffer: (data) => ipcRenderer.invoke('create-offer', data),
  updateOffer: (data) => ipcRenderer.invoke('update-offer', data),
  toggleOffer: (id, is_active) => ipcRenderer.invoke('toggle-offer', { id, is_active }),
  deleteOffer: (id) => ipcRenderer.invoke('delete-offer', id),
});

contextBridge.exposeInMainWorld('shiftsAPI', {
  startShift: (data) => ipcRenderer.invoke('start-shift', data),
  endShift: (data) => ipcRenderer.invoke('end-shift', data),
  getActiveShift: () => ipcRenderer.invoke('get-active-shift'),
  getAllShifts: () => ipcRenderer.invoke('get-all-shifts'),
  getShiftsPage: (page, limit) => ipcRenderer.invoke('get-shifts-page', { page, limit }),
  getShiftDetails: (shift_id) => ipcRenderer.invoke('get-shift-details', shift_id),
  updateShiftOpeningCash: (data) => ipcRenderer.invoke('update-shift-opening-cash', data),
  fixShiftsTable: () => ipcRenderer.invoke('fix-shifts-table'),
  fixAllShiftsIssues: () => ipcRenderer.invoke('fix-all-shifts-issues'),
  backupShiftsData: () => ipcRenderer.invoke('backup-shifts-data'),
  fixShiftsTypeIssue: () => ipcRenderer.invoke('fix-shifts-type-issue'),
  getShiftsFinancialStats: () => ipcRenderer.invoke('get-shifts-financial-stats'),
  getActiveShiftStats: () => ipcRenderer.invoke('get-active-shift-stats'),
  // دوال جديدة لحساب المصروفات في الشيفتات
  getShiftExpenses: (shift_id) => ipcRenderer.invoke('get-shift-expenses', shift_id),
  getAllShiftsExpenses: () => ipcRenderer.invoke('get-all-shifts-expenses'),
  getExpensesStatistics: (startDate, endDate) => ipcRenderer.invoke('get-expenses-statistics', { startDate, endDate }),
  // الإحصائيات التفصيلية للشيفتات
  getShiftProductsStats: (shift_id) => ipcRenderer.invoke('get-shift-products-stats', shift_id),
  getShiftSessionsStats: (shift_id) => ipcRenderer.invoke('get-shift-sessions-stats', shift_id),
  getShiftStandaloneSalesStats: (shift_id) => ipcRenderer.invoke('get-shift-standalone-sales-stats', shift_id),
  getShiftDetailedStats: (shift_id) => ipcRenderer.invoke('get-shift-detailed-stats', shift_id)
}); 

// Telegram Settings API
contextBridge.exposeInMainWorld('telegramAPI', {
  setSettings: ({ botToken, chatId }) => ipcRenderer.invoke('set-telegram-settings', { botToken, chatId }),
  getSettings: () => ipcRenderer.invoke('get-telegram-settings'),
  testSend: () => ipcRenderer.invoke('test-telegram-send'),
  addChat: (chatId) => ipcRenderer.invoke('add-telegram-chat', chatId),
  removeChat: (chatId) => ipcRenderer.invoke('remove-telegram-chat', chatId),
  getAllChats: () => ipcRenderer.invoke('get-all-telegram-chats')
});

// MikroTik Hotspot API
contextBridge.exposeInMainWorld('employeesAPI', {
  setTarget: (data) => ipcRenderer.invoke('set-employee-target', data),
  getTargets: () => ipcRenderer.invoke('get-employee-targets'),
  getStats: (data) => ipcRenderer.invoke('get-employee-stats', data),
  getPayments: (data) => ipcRenderer.invoke('get-employee-payments', data),
  createPayment: (data) => ipcRenderer.invoke('create-employee-payment', data)
});

contextBridge.exposeInMainWorld('hotspotAPI', {
  getSettings: () => ipcRenderer.invoke('hotspot-get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('hotspot-save-settings', settings),
  testConnection: (settings) => ipcRenderer.invoke('hotspot-test-connection', settings),
  getUsers: () => ipcRenderer.invoke('hotspot-get-users'),
  addUser: (userData) => ipcRenderer.invoke('hotspot-add-user', userData),
  deleteUser: (userId) => ipcRenderer.invoke('hotspot-delete-user', userId),
  toggleUser: (userId, disabled) => ipcRenderer.invoke('hotspot-toggle-user', { userId, disabled }),
  getProfiles: () => ipcRenderer.invoke('hotspot-get-profiles')
});