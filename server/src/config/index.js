let config = {
    useCLS: false,
};

exports.setConfig = (newConfig) => {
    config = { ...config, ...newConfig };
};

exports.getConfig = () => config;

exports.useCLS = () => config.useCLS;