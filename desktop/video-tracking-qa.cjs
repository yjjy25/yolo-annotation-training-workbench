/* Compatibility entry: the video workflow now stages drafts before dataset acceptance. */
module.exports=async context=>{process.env.XAL_QA_VIDEOREVIEW_ROOT=process.env.XAL_QA_VIDEOREVIEW_ROOT||process.env.XAL_QA_TRACKING_ROOT;return require('./video-review-qa.cjs')(context);};
