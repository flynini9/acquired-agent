// Translate application messages, never entity names, user input or records.
export function englishError(message:unknown,code?:unknown):string {
 const text=typeof message==='string'?message:'';
 if(text&&!/[\u3400-\u9fff]/u.test(text))return text;
 if(/倒序/.test(text))return 'This route would place a sequel before an earlier entry in its series. No route was saved.';
 const codes:Record<string,string>={
  sign_in_required:'Sign in with ChatGPT to continue.',
  public_quota:'The public beta request limit has been reached. Please wait for the limit to reset.',
  rate_limited:'Qloo is temporarily rate limited. Measurement stopped; this does not mean no route exists. Please wait before retrying.',
  upstream_unavailable:'Qloo is temporarily unavailable. Measurement stopped and your existing routes are preserved.',
  local_cooldown:'External requests are cooling down. Please wait before trying again.',
  signal_unavailable:'Qloo can find an entry but cannot currently measure its taste connections. Confirm a different exact entry; your inputs are preserved.',
  signal_check_rejected:'Qloo rejected the connection check for this entry. Confirm the exact catalog record before trying again.',
  signal_check_failed:'The entry connection check could not finish. Please try again later.',
  measurement_incomplete:'Some required connections could not be measured. No incomplete route was saved.',
  query_rejected:'Qloo rejected a required query. No incomplete route was saved.',
  constraint_broken:'A confirmed preference prevents this route. Review your preferences before trying again.',
  broken:'No complete measured route was found with these entries and preferences. Try another starting point or review your preferences.',
  invalid_input:'Please check your entries and confirm the exact destination and starting points.',
  no_key:'The site is not configured for live taste queries. Please contact the site owner.',
  auth:'The taste provider could not authorize this request. Please contact the site owner.',
  router:'The route could not be completed. Your existing routes and inputs are preserved.',
  pack_not_available:'This collection cannot currently be used. Confirm a specific catalog entry.',
  motivation_needs_detail:'Add a specific attraction or choose a supported taste tag before building.',
  expected_data_required:'The current saved version is required. Reopen your walk before saving.',
  session_missing:'This walk is unavailable in your account.',
  session_conflict:'A newer saved version exists. Choose which progress to keep.',
 };
 if(typeof code==='string'&&codes[code])return codes[code];
 if(/预算|180次|4分钟/.test(text))return 'This request reached its measurement budget. No incomplete route was saved.';
 if(/另一项测量/.test(text))return 'The agent is measuring another route. Please wait for it to finish.';
 if(/低分|两次/.test(text))return 'Rebuilding needs a saved liking score of 2 or less and is limited to two rebuilds per walk.';
 if(/找不到|读不出来|读取校验/.test(text))return 'This saved record could not be read. Your existing records are preserved.';
 if(/目的地|重新确认|无法核实/.test(text))return 'Confirm a valid entertainment destination and the exact catalog entries before continuing.';
 if(/配置|QLOO_API_KEY/.test(text))return 'The site is not configured for live taste queries. Please contact the site owner.';
 if(/输入/.test(text))return 'Please check your input and try again.';
 if(/数据库|核对外部/.test(text))return 'The service is temporarily unavailable. Please try again later.';
 return 'This operation could not finish. Your existing routes and inputs are preserved; please try again later.';
}
