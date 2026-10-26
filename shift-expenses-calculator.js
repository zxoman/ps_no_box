/**
 * حاسبة المصروفات في الشيفتات
 * Shift Expenses Calculator
 * 
 * هذا الملف يحتوي على دوال لحساب وإدارة المصروفات في الشيفتات
 */

class ShiftExpensesCalculator {
  constructor() {
    this.expensesAPI = window.expensesAPI;
    this.shiftsAPI = window.shiftsAPI;
  }

  /**
   * حساب المصروفات لشيفت محدد
   * @param {number} shift_id - معرف الشيفت
   * @returns {Promise<Object>} بيانات المصروفات
   */
  async calculateShiftExpenses(shift_id) {
    try {
      console.log('💰 حساب المصروفات للشيفت:', shift_id);
      
      const result = await this.expensesAPI.getShiftExpenses(shift_id);
      
      if (result.success) {
        const data = result.data;
        
        // تنسيق البيانات للعرض
        const formattedData = {
          shift_id: data.shift_id,
          shift_start: new Date(data.shift_start).toLocaleString('ar-SA'),
          shift_end: data.shift_end ? new Date(data.shift_end).toLocaleString('ar-SA') : 'الشيفت لا يزال نشط',
          total_expenses: data.total_expenses,
          expenses_count: data.expenses_count,
          shift_duration_hours: data.shift_duration_hours,
          expenses: data.expenses.map(expense => ({
            id: expense.id,
            title: expense.title,
            amount: expense.amount,
            category: expense.category || 'غير محدد',
            frequency: expense.frequency || 'غير محدد',
            date: new Date(expense.date).toLocaleString('ar-SA'),
            description: expense.description || ''
          })),
          expenses_by_category: data.expenses_by_category,
          expenses_by_frequency: data.expenses_by_frequency
        };
        
        console.log('✅ تم حساب مصروفات الشيفت:', formattedData);
        return formattedData;
      } else {
        throw new Error(result.error || 'خطأ في حساب المصروفات');
      }
    } catch (error) {
      console.error('❌ خطأ في حساب مصروفات الشيفت:', error);
      throw error;
    }
  }

  /**
   * حساب المصروفات لجميع الشيفتات
   * @returns {Promise<Object>} إحصائيات المصروفات لجميع الشيفتات
   */
  async calculateAllShiftsExpenses() {
    try {
      console.log('📊 حساب المصروفات لجميع الشيفتات...');
      
      const result = await this.expensesAPI.getAllShiftsExpenses();
      
      if (result.success) {
        const data = result.data;
        
        // تنسيق البيانات للعرض
        const formattedData = {
          total_shifts: data.total_shifts,
          total_expenses: data.total_expenses,
          shifts_with_expenses: data.shifts_with_expenses,
          average_expenses_per_shift: data.total_shifts > 0 ? data.total_expenses / data.total_shifts : 0,
          shifts_expenses: data.shifts_expenses.map(shift => ({
            shift_id: shift.shift_id,
            shift_start: new Date(shift.shift_start).toLocaleString('ar-SA'),
            shift_end: shift.shift_end ? new Date(shift.shift_end).toLocaleString('ar-SA') : 'الشيفت لا يزال نشط',
            total_expenses: shift.total_expenses,
            expenses_count: shift.expenses_count,
            expenses: shift.expenses.map(expense => ({
              id: expense.id,
              title: expense.title,
              amount: expense.amount,
              category: expense.category || 'غير محدد',
              frequency: expense.frequency || 'غير محدد',
              date: new Date(expense.date).toLocaleString('ar-SA'),
              description: expense.description || ''
            }))
          }))
        };
        
        console.log('✅ تم حساب مصروفات جميع الشيفتات:', formattedData);
        return formattedData;
      } else {
        throw new Error(result.error || 'خطأ في حساب المصروفات');
      }
    } catch (error) {
      console.error('❌ خطأ في حساب مصروفات جميع الشيفتات:', error);
      throw error;
    }
  }

  /**
   * حساب إحصائيات المصروفات
   * @param {Date} startDate - تاريخ البداية (اختياري)
   * @param {Date} endDate - تاريخ النهاية (اختياري)
   * @returns {Promise<Object>} إحصائيات المصروفات
   */
  async calculateExpensesStatistics(startDate = null, endDate = null) {
    try {
      console.log('📈 حساب إحصائيات المصروفات...');
      
      const result = await this.expensesAPI.getExpensesStatistics(startDate, endDate);
      
      if (result.success) {
        const data = result.data;
        
        // تنسيق البيانات للعرض
        const formattedData = {
          total_expenses: data.total_expenses,
          total_count: data.total_count,
          average_expense: data.average_expense,
          max_expense: data.max_expense,
          min_expense: data.min_expense,
          date_range: {
            start: data.date_range.start ? new Date(data.date_range.start).toLocaleString('ar-SA') : null,
            end: data.date_range.end ? new Date(data.date_range.end).toLocaleString('ar-SA') : null
          },
          expenses_by_category: Object.keys(data.expenses_by_category).map(category => ({
            category: category,
            total: data.expenses_by_category[category].total,
            count: data.expenses_by_category[category].count,
            percentage: data.expenses_by_category[category].percentage
          })),
          expenses_by_frequency: Object.keys(data.expenses_by_frequency).map(frequency => ({
            frequency: frequency,
            total: data.expenses_by_frequency[frequency].total,
            count: data.expenses_by_frequency[frequency].count,
            percentage: data.expenses_by_frequency[frequency].percentage
          }))
        };
        
        console.log('✅ تم حساب إحصائيات المصروفات:', formattedData);
        return formattedData;
      } else {
        throw new Error(result.error || 'خطأ في حساب الإحصائيات');
      }
    } catch (error) {
      console.error('❌ خطأ في حساب إحصائيات المصروفات:', error);
      throw error;
    }
  }

  /**
   * عرض تقرير المصروفات لشيفت محدد
   * @param {number} shift_id - معرف الشيفت
   * @param {HTMLElement} container - العنصر الذي سيتم عرض التقرير فيه
   */
  async displayShiftExpensesReport(shift_id, container) {
    try {
      const data = await this.calculateShiftExpenses(shift_id);
      
      const reportHTML = `
        <div class="shift-expenses-report">
          <h3>تقرير المصروفات - الشيفت ${shift_id}</h3>
          
          <div class="summary-cards">
            <div class="summary-card">
              <h4>إجمالي المصروفات</h4>
              <p class="amount">${data.total_expenses.toFixed(2)} ريال</p>
            </div>
            
            <div class="summary-card">
              <h4>عدد المصروفات</h4>
              <p class="count">${data.expenses_count}</p>
            </div>
            
            <div class="summary-card">
              <h4>مدة الشيفت</h4>
              <p class="duration">${data.shift_duration_hours ? data.shift_duration_hours.toFixed(2) + ' ساعة' : 'الشيفت لا يزال نشط'}</p>
            </div>
          </div>
          
          <div class="expenses-breakdown">
            <h4>تفصيل المصروفات حسب الفئة</h4>
            <div class="category-breakdown">
              ${Object.keys(data.expenses_by_category).map(category => `
                <div class="category-item">
                  <span class="category-name">${category}</span>
                  <span class="category-amount">${data.expenses_by_category[category].total.toFixed(2)} ريال</span>
                  <span class="category-count">(${data.expenses_by_category[category].count} مصروف)</span>
                </div>
              `).join('')}
            </div>
          </div>
          
          <div class="expenses-list">
            <h4>قائمة المصروفات</h4>
            <div class="expenses-table">
              ${data.expenses.map(expense => `
                <div class="expense-item">
                  <div class="expense-title">${expense.title}</div>
                  <div class="expense-amount">${expense.amount.toFixed(2)} ريال</div>
                  <div class="expense-category">${expense.category}</div>
                  <div class="expense-date">${expense.date}</div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;
      
      container.innerHTML = reportHTML;
      
    } catch (error) {
      container.innerHTML = `<div class="error">خطأ في عرض تقرير المصروفات: ${error.message}</div>`;
    }
  }

  /**
   * عرض تقرير المصروفات لجميع الشيفتات
   * @param {HTMLElement} container - العنصر الذي سيتم عرض التقرير فيه
   */
  async displayAllShiftsExpensesReport(container) {
    try {
      const data = await this.calculateAllShiftsExpenses();
      
      const reportHTML = `
        <div class="all-shifts-expenses-report">
          <h3>تقرير المصروفات - جميع الشيفتات</h3>
          
          <div class="summary-cards">
            <div class="summary-card">
              <h4>إجمالي المصروفات</h4>
              <p class="amount">${data.total_expenses.toFixed(2)} ريال</p>
            </div>
            
            <div class="summary-card">
              <h4>عدد الشيفتات</h4>
              <p class="count">${data.total_shifts}</p>
            </div>
            
            <div class="summary-card">
              <h4>الشيفتات التي تحتوي على مصروفات</h4>
              <p class="count">${data.shifts_with_expenses}</p>
            </div>
            
            <div class="summary-card">
              <h4>متوسط المصروفات لكل شيفت</h4>
              <p class="amount">${data.average_expenses_per_shift.toFixed(2)} ريال</p>
            </div>
          </div>
          
          <div class="shifts-list">
            <h4>تفصيل المصروفات لكل شيفت</h4>
            <div class="shifts-table">
              ${data.shifts_expenses.map(shift => `
                <div class="shift-item">
                  <div class="shift-info">
                    <h5>الشيفت ${shift.shift_id}</h5>
                    <p>من: ${shift.shift_start}</p>
                    <p>إلى: ${shift.shift_end}</p>
                  </div>
                  <div class="shift-expenses">
                    <p>إجمالي المصروفات: ${shift.total_expenses.toFixed(2)} ريال</p>
                    <p>عدد المصروفات: ${shift.expenses_count}</p>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;
      
      container.innerHTML = reportHTML;
      
    } catch (error) {
      container.innerHTML = `<div class="error">خطأ في عرض تقرير المصروفات: ${error.message}</div>`;
    }
  }

  /**
   * عرض إحصائيات المصروفات
   * @param {HTMLElement} container - العنصر الذي سيتم عرض الإحصائيات فيه
   * @param {Date} startDate - تاريخ البداية (اختياري)
   * @param {Date} endDate - تاريخ النهاية (اختياري)
   */
  async displayExpensesStatistics(container, startDate = null, endDate = null) {
    try {
      const data = await this.calculateExpensesStatistics(startDate, endDate);
      
      const reportHTML = `
        <div class="expenses-statistics">
          <h3>إحصائيات المصروفات</h3>
          
          <div class="summary-cards">
            <div class="summary-card">
              <h4>إجمالي المصروفات</h4>
              <p class="amount">${data.total_expenses.toFixed(2)} ريال</p>
            </div>
            
            <div class="summary-card">
              <h4>عدد المصروفات</h4>
              <p class="count">${data.total_count}</p>
            </div>
            
            <div class="summary-card">
              <h4>متوسط المصروف</h4>
              <p class="amount">${data.average_expense.toFixed(2)} ريال</p>
            </div>
            
            <div class="summary-card">
              <h4>أكبر مصروف</h4>
              <p class="amount">${data.max_expense.toFixed(2)} ريال</p>
            </div>
            
            <div class="summary-card">
              <h4>أصغر مصروف</h4>
              <p class="amount">${data.min_expense.toFixed(2)} ريال</p>
            </div>
          </div>
          
          <div class="category-statistics">
            <h4>المصروفات حسب الفئة</h4>
            <div class="category-chart">
              ${data.expenses_by_category.map(category => `
                <div class="category-item">
                  <span class="category-name">${category.category}</span>
                  <span class="category-amount">${category.total.toFixed(2)} ريال</span>
                  <span class="category-percentage">${category.percentage}%</span>
                  <span class="category-count">(${category.count} مصروف)</span>
                </div>
              `).join('')}
            </div>
          </div>
          
          <div class="frequency-statistics">
            <h4>المصروفات حسب التكرار</h4>
            <div class="frequency-chart">
              ${data.expenses_by_frequency.map(frequency => `
                <div class="frequency-item">
                  <span class="frequency-name">${frequency.frequency}</span>
                  <span class="frequency-amount">${frequency.total.toFixed(2)} ريال</span>
                  <span class="frequency-percentage">${frequency.percentage}%</span>
                  <span class="frequency-count">(${frequency.count} مصروف)</span>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;
      
      container.innerHTML = reportHTML;
      
    } catch (error) {
      container.innerHTML = `<div class="error">خطأ في عرض إحصائيات المصروفات: ${error.message}</div>`;
    }
  }
}

// إنشاء مثيل من الحاسبة
const shiftExpensesCalculator = new ShiftExpensesCalculator();

// تصدير الحاسبة للاستخدام في الملفات الأخرى
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ShiftExpensesCalculator;
} else {
  window.ShiftExpensesCalculator = ShiftExpensesCalculator;
  window.shiftExpensesCalculator = shiftExpensesCalculator;
}



