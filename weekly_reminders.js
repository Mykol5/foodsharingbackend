var currentDate = new GlideDateTime();

var secPlanObj = new GlideRecord("x_usaa3_application_security_plan");

// State = In Progress
secPlanObj.addEncodedQuery("state=2");

secPlanObj.query();

while (secPlanObj.next()) {

    // Ensure due date exists
    if (!secPlanObj.plan_due_date) {
        continue;
    }

    var dueDate = new GlideDateTime(secPlanObj.plan_due_date);

    // Stop reminders if plan is already overdue
    if (currentDate.getNumericValue() >= dueDate.getNumericValue()) {
        continue;
    }

    // Calculate business days remaining
    var businessDays = 0;
    var tempDate = new GlideDateTime(currentDate);

    while (tempDate.getNumericValue() < dueDate.getNumericValue()) {

        tempDate.addDaysUTC(1);

        var dayOfWeek = tempDate.getDayOfWeekUTC();

        // Exclude Saturday (6) and Sunday (7)
        if (dayOfWeek != 6 && dayOfWeek != 7) {
            businessDays++;
        }
    }

    // Stop reminders once escalation window starts
    if (businessDays <= 10) {
        continue;
    }

    // Weekly reminder logic
    var createdDate = new GlideDateTime(secPlanObj.sys_created_on);

    var result = GlideDateTime.subtract(createdDate, currentDate);

    result.getDisplayValue();

    var days = result.getDayPart();

    if ((days % 7) == 0) {

        gs.eventQueue(
            "x_usaa3_application_security_pln_reminder",
            secPlanObj,
            secPlanObj.sys_created_on
        );
    }
}
