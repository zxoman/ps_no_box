# حاسبة المصروفات في الشيفتات
## Shift Expenses Calculator

نظام شامل لحساب وإدارة المصروفات في الشيفتات المختلفة.

## المميزات

### 1. حساب المصروفات لشيفت محدد
- عرض إجمالي المصروفات للشيفت
- تفصيل المصروفات حسب الفئة
- تفصيل المصروفات حسب التكرار
- عرض قائمة كاملة بالمصروفات

### 2. حساب المصروفات لجميع الشيفتات
- إجمالي المصروفات لجميع الشيفتات
- متوسط المصروفات لكل شيفت
- عدد الشيفتات التي تحتوي على مصروفات
- تفصيل كل شيفت على حدة

### 3. إحصائيات المصروفات
- إجمالي المصروفات
- متوسط المصروف
- أكبر وأصغر مصروف
- توزيع المصروفات حسب الفئة
- توزيع المصروفات حسب التكرار

## الملفات المضافة

### 1. `main.js` - الدوال الأساسية
تم إضافة الدوال التالية:

```javascript
// حساب المصروفات لشيفت محدد
function getShiftExpenses(shift_id, cb)

// حساب المصروفات لجميع الشيفتات
function getAllShiftsExpenses(cb)

// حساب إحصائيات المصروفات
function getExpensesStatistics(startDate, endDate, cb)
```

### 2. `preload.js` - واجهة APIs
تم إضافة الدوال التالية إلى `expensesAPI` و `shiftsAPI`:

```javascript
// دوال جديدة لحساب المصروفات في الشيفتات
getShiftExpenses: (shift_id) => ipcRenderer.invoke('get-shift-expenses', shift_id),
getAllShiftsExpenses: () => ipcRenderer.invoke('get-all-shifts-expenses'),
getExpensesStatistics: (startDate, endDate) => ipcRenderer.invoke('get-expenses-statistics', { startDate, endDate })
```

### 3. `shift-expenses-calculator.js` - حاسبة المصروفات
كلاس JavaScript شامل يحتوي على:

```javascript
class ShiftExpensesCalculator {
  // حساب المصروفات لشيفت محدد
  async calculateShiftExpenses(shift_id)
  
  // حساب المصروفات لجميع الشيفتات
  async calculateAllShiftsExpenses()
  
  // حساب إحصائيات المصروفات
  async calculateExpensesStatistics(startDate, endDate)
  
  // عرض تقرير المصروفات لشيفت محدد
  async displayShiftExpensesReport(shift_id, container)
  
  // عرض تقرير المصروفات لجميع الشيفتات
  async displayAllShiftsExpensesReport(container)
  
  // عرض إحصائيات المصروفات
  async displayExpensesStatistics(container, startDate, endDate)
}
```

### 4. `shift-expenses-styles.css` - التنسيقات
ملف CSS شامل يحتوي على تنسيقات لجميع عناصر تقارير المصروفات.

### 5. `shift-expenses-demo.html` - ملف تجريبي
ملف HTML تجريبي يعرض كيفية استخدام النظام مع بيانات وهمية للاختبار.

## كيفية الاستخدام

### 1. الاستخدام الأساسي

```javascript
// إنشاء مثيل من الحاسبة
const calculator = new ShiftExpensesCalculator();

// حساب المصروفات لشيفت محدد
const shiftExpenses = await calculator.calculateShiftExpenses(1);

// حساب المصروفات لجميع الشيفتات
const allExpenses = await calculator.calculateAllShiftsExpenses();

// حساب الإحصائيات
const statistics = await calculator.calculateExpensesStatistics();
```

### 2. عرض التقارير

```javascript
// عرض تقرير المصروفات لشيفت محدد
await calculator.displayShiftExpensesReport(1, document.getElementById('container'));

// عرض تقرير جميع الشيفتات
await calculator.displayAllShiftsExpensesReport(document.getElementById('container'));

// عرض الإحصائيات
await calculator.displayExpensesStatistics(document.getElementById('container'));
```

### 3. استخدام APIs مباشرة

```javascript
// استخدام expensesAPI
const result = await window.expensesAPI.getShiftExpenses(1);
if (result.success) {
    console.log('المصروفات:', result.data);
}

// استخدام shiftsAPI
const allShifts = await window.shiftsAPI.getAllShiftsExpenses();
if (allShifts.success) {
    console.log('جميع الشيفتات:', allShifts.data);
}
```

## هيكل البيانات

### بيانات مصروفات الشيفت
```javascript
{
  shift_id: 1,
  shift_start: "2024-01-01 08:00:00",
  shift_end: "2024-01-01 16:00:00",
  total_expenses: 150.50,
  expenses_count: 5,
  shift_duration_hours: 8,
  expenses: [...],
  expenses_by_category: {...},
  expenses_by_frequency: {...}
}
```

### بيانات جميع الشيفتات
```javascript
{
  total_shifts: 10,
  total_expenses: 1500.75,
  shifts_with_expenses: 8,
  average_expenses_per_shift: 150.075,
  shifts_expenses: [...]
}
```

### بيانات الإحصائيات
```javascript
{
  total_expenses: 1500.75,
  total_count: 25,
  average_expense: 60.03,
  max_expense: 200.00,
  min_expense: 5.50,
  expenses_by_category: {...},
  expenses_by_frequency: {...}
}
```

## التنسيقات

النظام يستخدم تنسيقات CSS متجاوبة تدعم:
- الشاشات الكبيرة والصغيرة
- التصميم العربي (RTL)
- ألوان جذابة ومتدرجة
- تأثيرات تفاعلية
- بطاقات ملخص واضحة

## الاختبار

يمكنك استخدام الملف التجريبي `shift-expenses-demo.html` لاختبار النظام:
1. افتح الملف في المتصفح
2. جرب الحسابات المختلفة
3. راقب النتائج والتنسيقات

## المتطلبات

- Node.js و Electron
- قاعدة بيانات SQLite
- المتصفحات الحديثة (Chrome, Firefox, Safari, Edge)

## الدعم

النظام يدعم:
- اللغة العربية بالكامل
- التصميم المتجاوب
- البيانات في الوقت الفعلي
- التقارير التفصيلية
- الإحصائيات المتقدمة



