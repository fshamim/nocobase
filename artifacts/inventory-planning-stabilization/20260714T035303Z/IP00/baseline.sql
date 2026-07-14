select jsonb_pretty(jsonb_build_object(
  'database', current_database(),
  'capturedAt', clock_timestamp(),
  'counts', jsonb_build_object(
    'companies', (select count(*) from "silverCompanies"),
    'amazonAccounts', (select count(*) from "silverAmazonAccounts"),
    'products', (select count(*) from "silverProducts"),
    'companyProducts', (select count(*) from "silverCompanyProducts"),
    'inventorySnapshots', (select count(*) from "silverInventorySnapshots"),
    'families', (select count(*) from "silverCompanyProductFamilies"),
    'familyLinkedCompanyProducts', (select count(*) from "silverCompanyProducts" where "companyProductFamilyId" is not null),
    'orders', (select count(*) from "silverOrders"),
    'orderLines', (select count(*) from "silverOrderLines"),
    'supplierProducts', (select count(*) from "silverSupplierProducts"),
    'companyProductSupplierLinks', (select count(*) from "silverCompanyProductSuppliers"),
    'activityComments', (select count(*) from "silverActivityComments"),
    'listingDailyFacts', (select count(*) from "silverListingDailyFacts"),
    'attributionUsers', (select count(*) from users where coalesce(("systemSettings"->'ecobaseAttribution'->>'attributionOnly')::boolean,false)),
    'attributionUsersWithPasswords', (select count(*) from users where coalesce(("systemSettings"->'ecobaseAttribution'->>'attributionOnly')::boolean,false) and password is not null),
    'attributionAuthenticatorLinks', (select count(*) from users u join "usersAuthenticators" ua on ua."userId"=u.id where coalesce((u."systemSettings"->'ecobaseAttribution'->>'attributionOnly')::boolean,false)),
    'attributionRoleLinks', (select count(*) from "rolesUsers" ru join users u on u.id=ru."userId" where coalesce((u."systemSettings"->'ecobaseAttribution'->>'attributionOnly')::boolean,false))
  ),
  'companyInventory', (
    select coalesce(jsonb_agg(to_jsonb(x) order by x.company),'[]'::jsonb)
    from (
      select c.name company, count(distinct cp.id) "companyProducts", count(distinct i.id) "inventorySnapshots"
      from "silverCompanies" c
      left join "silverCompanyProducts" cp on cp."companyId"=c.id
      left join "silverInventorySnapshots" i on i."companyProductId"=cp.id
      group by c.name
    ) x
  ),
  'orderLineMapping', (
    select coalesce(jsonb_object_agg(status,count),'{}'::jsonb)
    from (select coalesce("productMappingStatus",'<null>') status,count(*) count from "silverOrderLines" group by 1) x
  ),
  'orderAuthority', (
    select coalesce(jsonb_object_agg(status,count),'{}'::jsonb)
    from (select coalesce("authorityStatus",'<null>') status,count(*) count from "silverOrders" group by 1) x
  ),
  'goldLatest', jsonb_build_object(
    'calculationDate',(select max("calculationDate") from "goldInventoryPlanningRows"),
    'rows',(select count(*) from "goldInventoryPlanningRows" where "calculationDate"=(select max("calculationDate") from "goldInventoryPlanningRows")),
    'paneFamilyDistribution',(
      select coalesce(jsonb_agg(to_jsonb(x) order by x.pane,x."familyRole"),'[]'::jsonb)
      from (select coalesce("commandCenterPane",'<null>') pane,coalesce("familyRole",'<null>') "familyRole",count(*) count from "goldInventoryPlanningRows" where "calculationDate"=(select max("calculationDate") from "goldInventoryPlanningRows") group by 1,2) x
    ),
    'actionDistribution',(
      select coalesce(jsonb_object_agg(status,count),'{}'::jsonb)
      from (select coalesce("actionStatus",'<null>') status,count(*) count from "goldInventoryPlanningRows" where "calculationDate"=(select max("calculationDate") from "goldInventoryPlanningRows") group by 1) x
    )
  ),
  'assertions',jsonb_build_object(
    'crossCompanyAccountDefects',(select count(*) from "silverCompanyProducts" cp join "silverAmazonAccounts" a on a.id=cp."amazonAccountId" where cp."companyId"<>a."companyId"),
    'etcAcceptedListingCount',(select count(*) from "silverProducts" where upper(asin)='B0177E9JPS' and sku='ETC-120A'),
    'etcForbiddenListingCount',(select count(*) from "silverProducts" where upper(asin)='B0177E9JPS' and sku='ETC120A'),
    'etcSupplierSkuLineCount',(select count(*) from "silverOrderLines" where upper(trim(coalesce("sourceAsin",'')))='B0177E9JPS' and trim(coalesce("sourceSupplierSku",''))='ETC120A'),
    'sroAcceptedExactRefs',(select count(*) from "silverSupplierExternalRefs" where "normalizedExternalSupplierCode" in ('SRO-12939','SRO-12572')),
    'sroRejectedExactRefs',(select count(*) from "silverSupplierExternalRefs" where "normalizedExternalSupplierCode" in ('SRO-1293','SRO-1257'))
  ),
  'latestImportRuns',(
    select coalesce(jsonb_agg(to_jsonb(x) order by x."startedAt" desc),'[]'::jsonb)
    from (
      select ir."sourceConnectionId",sc."sourceType",sc.domain,ir.status,ir."startedAt",ir."sourceVersion",ir."rowCount",ir."normalizedCount"
      from "ecobaseImportRuns" ir join "ecobaseSourceConnections" sc on sc.id=ir."sourceConnectionId"
      where ir.id in (select distinct on ("sourceConnectionId") id from "ecobaseImportRuns" order by "sourceConnectionId","startedAt" desc)
    ) x
  )
));
