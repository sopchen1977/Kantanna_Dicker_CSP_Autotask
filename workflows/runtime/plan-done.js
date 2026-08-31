// End of the plan loop. Nothing was changed in Autotask - this only records
// that every line has been looked at, and when.
return [{ json: { done: true, planned_at: new Date().toISOString() } }];
