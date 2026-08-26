// One summary item for the form completion page.
const items = $input.all();
const customers = {};
for (const i of items) customers[i.json.tenant_name || ''] = true;
return [{ json: {
  line_count: items.length,
  customer_count: Object.keys(customers).length,
} }];
