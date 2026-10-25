-- Saudi riyal. It is fixed to the US dollar (3.75 SAR per USD) and the dinar is fixed too (0.709 JOD per USD), so 1 JOD = 3.75 / 0.709 SAR.
insert into currencies(code,name,symbol,rate,decimals,round_step,sort_order)
values ('SAR','Saudi riyal','SAR',5.289140,2,1,4)
on conflict (code) do nothing;
