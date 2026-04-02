require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ai-telecaller')
  .then(async () => {
    console.log('MongoDB connected');
    const Call = require('./models/Call');
    
    // Test the aggregation pipeline
    const query = {};
    const calls = await Call.find(query).limit(5).select('startedAt endedAt durationSeconds');
    console.log("Sample calls:", calls);

    const stats = await Call.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalDurationSeconds: {
            $sum: {
              $max: [
                { $ifNull: ['$durationSeconds', 0] },
                {
                  $cond: [
                    { $and: [{ $ne: ['$startedAt', null] }, { $ne: ['$endedAt', null] }] },
                    { $divide: [{ $subtract: ['$endedAt', '$startedAt'] }, 1000] },
                    0
                  ]
                }
              ]
            }
          }
        }
      }
    ]);
    
    console.log("Aggregation stats:", JSON.stringify(stats, null, 2));

    const totalDurationSeconds = stats.length > 0 ? Math.floor(stats[0].totalDurationSeconds) : 0;
    console.log("Final totalDurationSeconds:", totalDurationSeconds);

    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
