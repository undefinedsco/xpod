const knex = require('knex')({
    client: 'sqlite3',
    connection: {
      filename: './data/quadstore.sqlite'
    },
    useNullAsDefault: true
  });
  
  async function testInsert() {
    try {
      // 检查表是否存在
      const exists = await knex.schema.hasTable('quadstore_test');
      if (!exists) {
        // 创建表
        await knex.schema.createTable('quadstore_test', (table) => {
          table.string('key').primary();
          table.string('value');
        });
        console.info('Table created');
      } else {
        await knex.schema.dropTable('quadstore_test');
        console.info('Table dropped');
        await knex.schema.createTable('quadstore_test', (table) => {
          table.string('key').primary();
          table.string('value');
        });
        console.info('Table created');
      }
  
      // 开始时间
      console.time('Insert Time');
  
      // 使用事务批量插入数据
      await knex.transaction(async (trx) => {
        const data = [];
        for (let i = 0; i < 1000; i++) {
          data.push({ key: `key${i}`, value: `value${i}` });
        }
        const batchSize = 100; // 每批插入的记录数
        for (let i = 0; i < data.length; i += batchSize) {
          const batch = data.slice(i, i + batchSize);
          // const deleteBatch = batch.map((item) => ({ key: item.key }));
          // await trx('quadstore_test').delete(deleteBatch);
          // await trx('quadstore_test').insert(batch);
          for (const item of batch) {
            await trx.delete().from('quadstore_test').where('key', item.key);
            await trx.insert(item).into('quadstore_test');
          }
          console.info(`Inserted ${batch.length} records`);
        }
      });
  
      // 结束时间
      console.timeEnd('Insert Time');
      const insertedData = await knex('quadstore_test').select('*').limit(10);
      console.log('Inserted data:', insertedData);
    } catch (error) {
      console.error('Error inserting data:', error);
    } finally {
      // 关闭数据库连接
      await knex.destroy();
    }
  }
  
  testInsert();