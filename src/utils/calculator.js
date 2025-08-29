const calculateFeeAmount = (total, isFixed, fixedAmount, isPercentage, percentageAmount) => {
    const fixedFee = isFixed ? fixedAmount || 0 : 0;
    const percentageFee = isPercentage ? total * (percentageAmount || 0) / 100 : 0;
    var fee = ceilTwoDecimal(fixedFee + percentageFee);
    return fee || 0;
}

function ceilTwoDecimal(number) {
    return Math.ceil(number * 100) / 100;
}

function downTwoDecimal(number) {
    return Math.floor(number * 100) / 100;
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

module.exports = {
    calculateFeeAmount,
    ceilTwoDecimal,
    downTwoDecimal,
    sleep
}